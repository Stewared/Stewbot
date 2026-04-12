// #region CommandBoilerplate
const Categories = require("./modules/Categories");
const client = require("../client.js");
const { Guilds, Users, GuildUsers, guildByObj, userByObj } = require("./modules/database.js");
const { Events, SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageType, AutoModerationRuleEventType, AutoModerationRuleTriggerType, AutoModerationActionType, Guild } = require("discord.js");
function applyContext(context = {}) {
    for (let key in context) {
        this[key] = context[key];
    }
}

// NOTE:
// This is a PRIORITY module.
// That means this module will be run before any others
//
// Impacts:
//  1. This module's MessageCreate handler sets a msg.filtered attribute on the msg object
//     that can be used elsewhere in the code.


const leetMap = require("../data/filterLeetmap.json");
const { sendHook, limitLength, notify } = require("../utils.js");
const config = require("../data/config.json");
const LRUCache = require("lru-cache").LRUCache;
const ms = require("ms");
// var RE2 = require("re2");

/**
 * Cache for guild.filter.blacklist
 * @type {LRUCache<string, import("./modules/database.js").RawGuildDoc['filter']>}
 * */
let guildFilterCache = new LRUCache({ ttl: ms("5s"), max: 50 });

// This is a function built to support regex filters, which are currently not implemented
// function verifyRegex(regexStr) {
//     // returns: [isValid, error]

//     // Check for backtracing
//     // if (!safe(regexStr)) {
//     //     return [false, "This regex has catastrophic backtracking, please improve the regex and try again"]
//     // }

//     // Check for RE2 compatibility
//     try {
//         new RE2(regexStr, 'ui');
//     } catch {
//         return [false, "This regex is invalid or uses features unsupported by [RE2](https://github.com/google/re2-wasm)"]
//     }
//     return [true, "Added to the filter."];

//     // TODO evaluate user regexes like this:
//     // const regex = new RE2(userProvidedRegex, 'ui'); // TODO: figure out some system for flags - i should default on but some uses cases may need it off
//     // const result = regex.exec(msg.content);
//     // console.log(result);
// }

function escapeRegex(input) {
    return input.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function defangURL(message) {
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    return message.replace(urlPattern, (url) => {
        return url.replace(/:\/\//g, "[://]").replace(/\./g, "[.]");
    });
}

function normalizeFilterWord(word) {
    return String(word || "")
        .replace(/\r/g, "")
        .trim();
}

function splitLegacyFilterEntry(entry) {
    return String(entry || "")
        .split(/\n+/)
        .map(normalizeFilterWord)
        .filter(Boolean);
}

function buildBlockedWordRegex(blockedWord) {
    let word = Array.from(blockedWord, char => {
        const mappedChar = leetMap[char.toLowerCase()];
        return mappedChar || escapeRegex(char);
    }).join("");

    if (blockedWord.length > 3) {
        word += "(ing|s|ed|er|ism|ist|es|ual)?";
    }

    return new RegExp(`(\\b|^)${word}(\\b|$)`, "ig");
}

function parseImportedFilterWords(dataText) {
    return dataText
        .split(/[\r\n,]+/)
        .map(normalizeFilterWord)
        .filter(Boolean);
}

/** @deprecated Use `censor()` or `isDirty()` instead */
const checkDirty = async function(guildID, what, filter = false, applyGlobalFilter = false) { // This function is important enough we can make it global
    // If filter is false, it returns: hasBadWords
    // If filter is true, it returns [hadBadWords, censoredMessage, wordsFound]
    // guildID can supply an array for the blacklist instead.

    const originalContent = what; // Because we're preprocessing content, if the message was clean allow the original content without preprocessing

    if (!guildID || !what)
        if (!filter) return false;
        else return [false, what, []];

    // Preprocessing - anything here is destructive and will be processed this way if filtered
    what = String(what).replace(/<:(\w+):[0-9]+>/g, ":$1:"); // unsnowflake emojis
    what = what.replace(/[\u200B-\u200D\u00AD]/g, ""); // strip 0-widths
    what = what.normalize("NFKD"); // unicode variants
    what = what.replace(/(\s)\s+/g, "$1"); // collapse spacing

    let dirty = false;
    let foundWords = []; // keep track of all filtered words to later tell the user what was filtered

    let blacklist = [];

    if (typeof(guildID) == "string") {
        // TODO: consider way to rewrite this to cache blocked words. As this currently queries the DB on every single message
        // @ts-ignore - custom findOrCreate method is not typed
        const localGuild = await Guilds.findOrCreate({ id: guildID })
            .select("filter.blacklist")
            .lean();

        // For stewbot-created content (like AI), filter from our server too
        blacklist = localGuild?.filter?.blacklist || [];
        if (applyGlobalFilter) {
            // @ts-ignore - custom findOrCreate method is not typed
            const homeGuild = await Guilds.findOrCreate({ id: config.homeServer })
                .select("filter.blacklist")
                .lean();

            const globalBlacklist = homeGuild?.filter?.blacklist || [];
            blacklist = [...new Set([...(blacklist || []), ...globalBlacklist])];
        }
    }
    else if (guildID instanceof Array) {
        blacklist = guildID;
    }

    if (blacklist) for (const rawBlockedWord of blacklist) {
        // Ignore the new beta json format for now
        if (typeof(rawBlockedWord) !== "string") {
            continue;
        }

        for (let blockedWord of splitLegacyFilterEntry(rawBlockedWord)) {
            // Unsnowflake blocked word to match unsnowflaked message
            blockedWord = blockedWord.replace(/<:(\w+):[0-9]+>/g, ":$1:");

            let blockedWordRegex;
            try {
                blockedWordRegex = buildBlockedWordRegex(blockedWord);
            }
            catch (e) {
                // This should only ever be hit on old servers that have invalid regex before the escapeRegex was implemented
                if (!e?.message?.includes?.("http")) notify("Caught filter error:\n" + JSON.stringify(e.message) + "\n" + e.stack);
                // We can ignore this filter word
                continue;
            }

            // Check for the word
            if (blockedWordRegex.test(what) || what === blockedWord) {
                dirty = true;
                if (!filter) {
                    return true;
                }
                else {
                    foundWords.push(blockedWord);
                    what = what.replace(blockedWordRegex, "[\\_]");
                }
            }
        }
    }

    if (!filter) {
        // If we passed the check without exiting, it's clean
        return false;
    }
    else {
        // If we're filtering, it needs a more structured output

        // Additional sanitization content
        if (dirty) {
            what = defangURL(what);
        }
        else {
            what = originalContent; // Put snowflakes back how they were
        }

        return [dirty, what, foundWords];
    }
};

// Gets the home server blacklist, which is always enabled.
async function getCachedHomeBlacklist() {
    if (!config.homeServer) return [];

    // Cache guild
    if (!guildFilterCache.has("home-blacklist")) {
        const globalGuild = await Guilds.findOne({ id: config.homeServer })
            .select("filter.blacklist")
            .lean({ defaults: true });

        guildFilterCache.set("home-blacklist", globalGuild.filter, {
            "ttl": ms("5m") // Our guild won't change often, so.
        });
    }

    const blacklist = guildFilterCache.get("home-blacklist").blacklist;

    return blacklist;
}

/** @param {String|Guild|import("./modules/database.js").RawGuildDoc} guild */
async function getCachedServerBlacklist(guild) {
    // Resolve Guild to id
    if (guild instanceof Guild) {
        guild = guild.id;
    }

    // Populate cache
    let guildId;
    if (typeof(guild) == "string") {
        guildId = guild;

        // Confirm in cache
        if (!guildFilterCache.has(guildId)) {
            const globalGuild = await Guilds.findOne({ id: guildId })
                .select("filter.blacklist")
                .lean({ defaults: true });

            guildFilterCache.set(guildId, globalGuild.filter);
        }
    }
    else /** It's a mongo object */ {
        // Set directly
        guildId = guild.id;
        guildFilterCache.set(guildId, guild.filter);
    }

    // Set blacklist
    const thisServerFilter = guildFilterCache.get(guildId);
    return thisServerFilter.blacklist;
}

/**
 * This function censors output against the specified server and the home server.
 *
 * @param {String} text - The text to censor.
 * @param {String|Guild|import("./modules/database.js").RawGuildDoc} guild - The guild as a MongoDB object, guild ID, or discord.js object. A MongoDB object is preferable, as it requires less lookups.
 * @param {boolean} [global=false] Whether to apply the home server filter. This should be applied to all output that looks like it is coming from stewbot, e.g. AI.
 *
 * @returns {Promise<[ Boolean, String, String[] ]>} A promise for the filtered text and found words.
 */
async function censorWithFound(text, guild, global = false) {
    // Start off blacklist with our baseline
    let blacklist = global ? await getCachedHomeBlacklist() : [];

    // Add server filter
    if (guild) blacklist = blacklist.concat(await getCachedServerBlacklist(guild));

    // @ts-ignore - proxy to deprecated method with complicated return
    const [wasFiltered, censoredText, foundWords] = await checkDirty(blacklist, text, true);

    if (!wasFiltered) return [false, text, []];
    else return [wasFiltered, censoredText, foundWords];
}

/**
 * This function censors output against the specified server and the home server.
 * Providing just text will result in checking against the home server.
 *
 * @param {String} text - The text to censor.
 * @param {String|Guild|import("./modules/database.js").RawGuildDoc?} guild - The guild as a MongoDB object, guild ID, or discord.js object. A MongoDB object is preferable, as it requires less lookups.
 * @param {boolean?} [global] Whether to apply the home server filter. This should be applied to all output that looks like it is coming from stewbot, e.g. AI.
 *
 * @returns {Promise<String>} A promise for the filtered text.
 */
async function censor(text, guild = undefined, global = false) {
    // If only text is provided, assume we're checking globally
    if (!guild) global = true;

    const [, censoredText] = await censorWithFound(text, guild, global);
    return censoredText;
}

/**
 * This function checks text against the specified server and the home server.
 * Call without arguments to check against home server.
 *
 * @param {String} text - The text to sensor.
 * @param {String|Guild|import("./modules/database.js").RawGuildDoc?} guild - The guild as a MongoDB object, guild ID, or discord.js object. A MongoDB object is preferable, as it requires less lookups.
 * @param {boolean?} [global=false] Whether to apply the home server filter. This should be applied to all output that looks like it is coming from stewbot, e.g. AI.
 *
 * @returns {Promise<boolean>} A promise for the filtered text and found words.
 */
async function isDirty(text, guild = undefined, global = false) {
    // If only text is provided, assume we're checking globally
    if (!guild) global = true;

    // Start off blacklist with our baseline
    let blacklist = global ? await getCachedHomeBlacklist() : [];

    // Add server filter
    if (guild) blacklist = blacklist.concat(await getCachedServerBlacklist(guild));

    /** @type {boolean} */
    // @ts-ignore - proxy to deprecated method with complicated return
    const dirty = await checkDirty(blacklist, text, false);

    return dirty;
}


/** @type {import("../command-module").CommandModule} */
module.exports = {
    checkDirty: checkDirty,           // Deprecated
    censorWithFound: censorWithFound, // For knowing what was filtered, and if it was.
    censor: censor,                   // Args: Text = Global  |  Text+Guild = Local  |  Text+Guild+Boolean = Global(?)+Local
    isDirty: isDirty,                 // Args: Text = Global  |  Text+Guild = Local  |  Text+Guild+Boolean = Global(?)+Local

    data: {
        // Slash command data
        command: new SlashCommandBuilder().setName("filter")
            .setDescription("Manage the filter for this server")
            .addSubcommand(command =>
                command.setName("config").setDescription("Configure the filter for this server")
                    .addBooleanOption(option =>
                        option.setName("active").setDescription("Should I remove messages that contain words configured in the blacklist?")
                            .setRequired(true)
                    )
                    .addBooleanOption(option =>
                        option.setName("censor").setDescription("Should I remove the filtered words from the message (true), or delete the message entirely (false)?")
                    )
                    .addBooleanOption(option =>
                        option.setName("log").setDescription("Post a summary of filtered messages to a staff channel? (Must set 'channel' on this command if true)")
                    )
                    .addChannelOption(option =>
                        option.setName("channel").setDescription("Which channel should I post summaries of deleted messages to?")
                            .addChannelTypes(ChannelType.GuildText)
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(command =>
                command.setName("add").setDescription("Add a word to the filter")
                    .addStringOption(option =>
                        option.setName("word").setDescription("The word to blacklist")
                            .setRequired(true)
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(command =>
                command.setName("remove").setDescription("Remove a word from the filter")
                    .addStringOption(option =>
                        option.setName("word").setDescription("The word to remove from the blacklist")
                            .setRequired(true)
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(command =>
                command.setName("import").setDescription("Import a CSV wordlist")
                    .addAttachmentOption(option =>
                        option.setName("file").setDescription("A .csv with comma separated words you'd like to block")
                            .setRequired(true)
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

        extra: { "contexts": [0], "integration_types": [0], "cat": 6 },

        // Optional fields
        requiredGlobals: [],

        priority: 0,

        help: {
            config: {
                helpCategories: [Categories.General, Categories.Administration, Categories.Configuration, Categories.Server_Only, Categories.Safety],
                shortDesc: "Manage the filter for this server",
                detailedDesc:
                    `Configure an automatic filter for this server, Stewbot allows you to censor messages without deleting them all the way.`
            },
            add: {
                helpCategories: [Categories.Administration, Categories.Configuration, Categories.Server_Only],
                shortDesc: "Add a word to the filter",
                detailedDesc:
                    `Add the specified word to the filter for Stewbot to delete or censor on sight`
            },
            remove: {
                helpCategories: [Categories.Administration, Categories.Configuration, Categories.Server_Only],
                shortDesc: "Remove a word from the filter",
                detailedDesc:
                    `Remove the specified from the filter and allow posts to contain that word once more`
            },
            import: {
                helpCategories: [Categories.Administration, Categories.Configuration, Categories.Server_Only],
                shortDesc: "Import a CSV wordlist",
                detailedDesc:
                    `Import a .csv file containing a list of words separated by commas to block. You can generate one from another server's filter using the ${cmds.view_filter.mention} command.`
            }
        }
    },

    async execute(cmd, context) {
        applyContext(context);

        const rawWord = cmd.options.getString("word");
        const word = normalizeFilterWord(rawWord);

        const guild = await guildByObj(cmd.guild);

        if (!cmd.guild?.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageMessages)) {
            guild.filter.active = false;
            cmd.followUp(`I cannot run a filter for this server. I need the MANAGE_MESSAGES permission first, otherwise I cannot delete messages.`);
            return;
        }
        switch (cmd.options.getSubcommand()) {

            case "add":
                if (!word || /[\r\n]/.test(rawWord || "")) {
                    cmd.followUp("Please provide one word or phrase at a time.");
                    break;
                }

                if (guild.filter.blacklist.includes(word)) {
                    cmd.followUp({
                        "ephemeral": true,
                        "content": `The word ||${word}|| is already in the blacklist.${guild.filter.active
                            ? ""
                            : `To begin filtering in this server, use ${cmds.filter.config.mention}.`
                        }`
                    });
                }
                else {
                    guild.filter.blacklist.push(word);
                    cmd.followUp(`Added ||${word}|| to the filter for this server.${guild.filter.active
                        ? ""
                        : `\n\nThe filter for this server is currently disabled. To enable it, use ${cmds.filter.config.mention}.`
                    }`);

                    try {
                        const existingRules = await cmd.guild.autoModerationRules.fetch();
                        let profileRule = existingRules.find(rule => rule.triggerType === 6);

                        // Try blocking this word from member profiles with AutoMod
                        if (!profileRule) {
                            await cmd.guild.autoModerationRules.create({
                                name: `Stewbot Profile Filter`,
                                enabled: true,
                                eventType: AutoModerationRuleEventType.MemberUpdate,
                                triggerType: AutoModerationRuleTriggerType.MemberProfile,
                                triggerMetadata: {
                                    keywordFilter: [word]
                                },
                                actions: [{
                                    type: 4
                                }]
                            });
                        }
                        else {
                            // Rebrand the rule to us if they already have one
                            if (profileRule.name !== "Stewbot Profile Filter") {
                                await profileRule.edit({
                                    name: "Stewbot Profile Filter",
                                    enabled: true,
                                    actions: [{
                                        type: AutoModerationActionType.BlockMemberInteraction
                                    }]
                                });
                            }

                            // Update existing rule
                            const updatedKeywords = new Set([
                                ...(profileRule.triggerMetadata.keywordFilter || []),
                                word
                            ]);

                            await profileRule.edit({
                                triggerMetadata: {
                                    keywordFilter: Array.from(updatedKeywords)
                                },
                                enabled: true
                            });
                        }
                    }
                    catch (error) {
                        if (error.code !== 50013 && error.code !== 50001) {
                            throw error;
                        }
                    }
                }
                break;

            case "remove":
                if (!word || /[\r\n]/.test(rawWord || "")) {
                    cmd.followUp("Please provide one word or phrase at a time.");
                    break;
                }

                if (guild.filter.blacklist.includes(word)) {
                    guild.filter.blacklist.splice(guild.filter.blacklist.indexOf(word), 1);
                    cmd.followUp(`Alright, I have removed ||${word}|| from the filter.`);
                }
                else {
                    cmd.followUp(`I'm sorry, but I don't appear to have that word in my blacklist. Are you sure you're spelling it right? You can use ${cmds.view_filter.mention} to see all filtered words.`);
                }

                // Remove the word from our username profile filter
                try {
                    const existingRules = await cmd.guild.autoModerationRules.fetch();
                    let profileRule = existingRules.find(rule => rule.triggerType === 6 && rule.name === "Stewbot Profile Filter");
                    if (profileRule) {
                        const updatedKeywords = new Set(profileRule.triggerMetadata.keywordFilter || []);
                        updatedKeywords.delete(word);

                        await profileRule.edit({
                            triggerMetadata: {
                                keywordFilter: Array.from(updatedKeywords)
                            }
                        });
                    }
                }
                catch (error) {
                    if (error.code !== 50001) {
                        throw error;
                    }
                }

                break;

            case "config":
                var disclaimers = [];
                guild.filter.active = cmd.options.getBoolean("active");
                if (cmd.options.getBoolean("censor") !== null) guild.filter.censor = cmd.options.getBoolean("censor");
                if (cmd.options.getBoolean("log") !== null) guild.filter.log = cmd.options.getBoolean("log");
                if (cmd.options.getChannel("channel") !== null) guild.filter.channel = cmd.options.getChannel("channel").id;

                if (!cmd.guild?.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageWebhooks) && guild.filter.censor) {
                    guild.filter.censor = false;
                    disclaimers.push(`I cannot run censoring for this server, I need the MANAGE_WEBHOOKS permission first, otherwise I can't post a censored version.`);
                }
                if (guild.filter.channel === "" && guild.filter.log) {
                    guild.filter.log = false;
                    disclaimers.push(`No channel was set to log summaries of deleted messages to, so logging these is turned off.`);
                }
                else if (guild.filter.log) {
                    const logChannel = client.channels.cache.get(guild.filter.channel);
                    if (!logChannel || !logChannel.isSendable()) {
                        guild.filter.log = false;
                        disclaimers.push(`I cannot send messages to the specified log channel for this server, so logging deleted messages has been turned off.`);
                    }
                }
                cmd.followUp(`Filter configured.${disclaimers.map(d => `\n\n${d}`).join("")}`);

                break;

            case "import":
                // TODO: make sure this works - it needs a major rewrite anyways. Allow from server ID and other stuff
                const attachmentURL = cmd.options.getAttachment("file").url;
                try {
                    const data = await fetch(attachmentURL);
                    const dataText = await data.text();
                    const badWords = [...new Set(parseImportedFilterWords(dataText))];
                    let addedWords = [];
                    badWords.forEach(importedWord => {
                        if (!guild.filter.blacklist.includes(importedWord)) {
                            guild.filter.blacklist.push(importedWord);
                            addedWords.push(importedWord);
                        }
                    });
                    await cmd.followUp(addedWords.length > 0 ? limitLength(`Added the following words to the blacklist:\n- ||${addedWords.join("||\n- ||")}||`) : `Unable to add any of the words to the filter. Either there aren't any in the CSV, it's not formatted right, or all of the words are in the blacklist already.`);
                }
                catch {
                    cmd.followUp("Sorry, failed to import words.");
                }
                break;
        }

        guild.save();
    },

    async [Events.MessageCreate](msg, context, guildStore) {
        if (!msg.guild) return;
        if (msg.webhookId) return; // Ignore webhooks, since we post filters as webhooks.

        applyContext(context);

        let wasFiltered = false;

        // Filter
        if (guildStore?.filter?.active) {
            let [filtered, filteredContent, foundWords] = await censorWithFound(msg.content, guildStore, false);

            if (filtered) {
                let originalContent = msg.content;

                // Set this so that modules down the line are working with clean content, worst case.
                msg.content = filteredContent;

                const user = await userByObj(msg.author); // TODO: lean read if this isn't cached somewhere else?

                // Increment infractions
                await GuildUsers.updateOne(
                    { guildId: msg.guild.id, userId: msg.author.id },
                    { $inc: { infractions: 1 } },
                    { upsert: true, setDefaultsOnInsert: false }
                );

                // Send webhook
                msg.delete().catch(() => null);
                if (guildStore?.filter?.censor) {
                    var replyBlip = "";
                    if (msg.type === MessageType.Reply) {
                        var rMsg = await msg.fetchReference();
                        replyBlip = `_[Reply to **${rMsg.author.username}**: ${rMsg.content
                            .slice(0, 22)
                            .replace(/(https?:\/\/|\n)/gi, "")
                            .replace(/@/gi, "[@]")}${rMsg.content.length > 22
                            ? "..."
                            : ""
                        }](<https://discord.com/channels/${rMsg.guild.id}/${rMsg.channel.id}/${rMsg.id}>)_\n`;
                    }

                    const filteredMessageData = {
                        "username": msg.member?.nickname || msg.author.globalName || msg.author.username,
                        "avatarURL": msg.member?.displayAvatarURL(),
                        "content":
                            limitLength(
                                `\`\`\`\nThe following message from ${msg.author.username} has been censored by Stewbot.\`\`\`${
                                    replyBlip
                                }${msg.content}`)
                    };

                    sendHook(filteredMessageData, msg, true);
                }
                if (user.config.dmOffenses && msg.webhookId === null) {
                    try {
                        msg.author.send(
                            limitLength(
                                `Your message in **${msg.guild.name}** was ${guildStore.filter.censor
                                    ? "censored"
                                    : "deleted"
                                } due to the following word${foundWords.length > 1 ? "s" : ""} being in the filter: ` +
                                `||${foundWords.join("||, ||")}||${user.config.returnFiltered
                                    ? "```\n" +
                                    originalContent.replaceAll("`", "\\`") +
                                    "```"
                                    : ""
                                }`
                            )
                        ).catch(() => { });
                    }
                    catch { }
                }
                if (guildStore.filter.log && guildStore.filter.channel) {
                    const c = client.channels.cache.get(guildStore.filter.channel);
                    if (c?.isSendable()) {
                        c.send(limitLength(
                            `I have ${guildStore.filter.censor ? "censored" : "deleted"} a message from **${msg.author.username}** in <#${msg.channel.id}> for the following blocked word${foundWords.length > 1 ? "s" : ""}: ` +
                            `||${foundWords.join("||, ||")}||\`\`\`\n` +
                            `${originalContent
                                .replaceAll("`", "\\`") // Don't allow breaking out of code block
                                .replaceAll(/(?<=https?:\/\/[^(\s|/)]+)\./gi, "[.]") // defang URL (prevent bad URLs from embedding, phishing from being clicked, etc)
                                .replaceAll(/(?<=https?):\/\//gi, "[://]")
                            }\`\`\``)
                        );
                    }
                    else {
                        await guildByObj(msg.guild, {
                            "filter.log": false
                        });
                        // (.save doesn't work here because we're reading guild in read-only for speed)
                    }
                }
                return;
            }
        }

        // @ts-ignore - custom property
        msg.filtered = wasFiltered;
    },

    async [Events.MessageUpdate](_, msg, readGuild) {
        if (msg.guild?.id === undefined || client.user.id === msg.author?.id) return; // Ignore self and DMs
        if (!readGuild?.filter?.active) return;

        // Filter edit handler
        let [filtered, _filteredContent, foundWords] = await censorWithFound(msg.content, readGuild, false);

        if (filtered) {
            if (msg.deletable) msg.delete().catch(() => null);

            Users.updateOne({ id: msg.author.id }, {
                $inc: { infractions: 1 }
            });

            if (readGuild.filter.censor && msg.channel.isSendable()) {
                msg.channel.send({ content: `A post by <@${msg.author.id}> sent at <t:${Math.round(msg.createdTimestamp / 1000)}:f> <t:${Math.round(msg.createdTimestamp / 1000)}:R> has been deleted due to retroactively editing a blocked word into the message.`, allowedMentions: { parse: [] } });
            }

            // Don't DM on edit offense, *most* often this is due to discord retroactively fixing broken tensor links, I suspect.
            // const userSettings = await Users.findOne({ id: msg.author.id })
            //     .select("config.returnFiltered")
            //     .lean({ virtuals: true });
            // if (userSettings.dmOffenses && !msg.author.bot) {
            //     msg.author.send(limitLength(`Your message in **${msg.guild.name}** was deleted due to editing in the following word${foundWords.length > 1 ? "s" : ""} that are in the filter: ||${foundWords.join("||, ||")}||${userSettings.config.returnFiltered
            //         ? "```\n" + msg.content.replaceAll("`", "\\`") + "```"
            //         : ""
            //         }`)).catch(e => { });
            // }

            if (readGuild.filter.log && readGuild.filter.channel) {
                let logChannel = client.channels.cache.get(readGuild.filter.channel);
                if (logChannel.isSendable()) logChannel.send(limitLength(`I have deleted a message from **${msg.author.username}** in <#${msg.channel.id}> for editing in the following blocked word${foundWords.length > 1 ? "s" : ""}: ||${foundWords.join("||, ||")}||\`\`\`\n${msg.content.replaceAll("`", "\\`")}\`\`\``));
            }

            return;
        }
    },

    async [Events.MessageReactionAdd](react, user, _details, readGuild) {
        if (react.message.guildId === null) return;

        // Filter reactions
        if (readGuild?.filter?.active && react.message.guild?.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageMessages)) {
            if (await isDirty(`${react._emoji}`, readGuild)) {
                react.remove();
                if (readGuild.filter.log) {
                    var channel = client.channels.cache.get(readGuild.filter.channel);
                    if (channel.isSendable()) {
                        channel.send({
                            content: `I removed a ${react._emoji.id === null ? react._emoji.name : `<:${react._emoji.name}:${react._emoji.id}>`} reaction from https://discord.com/channels/${react.message.guild.id}/${react.message.channel.id}/${react.message.id} added by <@${user.id}> due to being in the filter.`,
                            allowedMentions: { parse: [] }
                        });
                    }
                    else {
                        Guilds.updateOne({ id: react.message.guild.id }, {
                            $set: { "filter.active": false }
                        });
                    }
                }
                return;
            }
        }
        else if (readGuild.filter.active) {
            Guilds.updateOne({ id: react.message.guild.id }, {
                $set: { "filter.active": false }
            });
        }
    }
};
