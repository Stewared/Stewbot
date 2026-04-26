// #region CommandBoilerplate
const Categories = require("./modules/Categories");
const client = require("../client.js");
const { Guilds, guildByID, guildByObj } = require("./modules/database.js");
const { Events, InteractionContextType: IT, ApplicationIntegrationType: AT, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");
const ms = require("ms");
function applyContext(context = {}) {
    for (let key in context) {
        this[key] = context[key];
    }
}

// #endregion CommandBoilerplate

const config = require("../data/config.json");

function getEmojiFromMessage(emoji) {
    emoji = emoji.trim();

    // if emoji is a discord custom emoji, return the emoji
    if (emoji.match(/<a?:\w+:\d+>/)) {
        return emoji;
    }

    // if emoji is a unicode emoji, return the emoji encoded as a list of 6 digit hex values
    return emoji.split("").map(char => char.codePointAt(0).toString(16)
        .padStart(6, "0"))
        .join("");
}

function parseEmoji(emoji) {
    if (emoji.match(/<a?:\w+:\d+>/)) {
        return emoji;
    }

    if (emoji.length % 6 !== 0) {
        return emoji;
    }

    try {
        // split into groups of 6 characters and convert to unicode
        return String.fromCodePoint(...emoji.match(/.{6}/g).map(hex => parseInt(hex, 16)));
    }
    catch {
        return emoji;
    }
}

function getStarMsg(msg) {
    var starboardHeaders = [
        `Excuse me, there is a new message.`,
        `I have detected a notification for you.`,
        `Greetings, esteemed individuals, a new message has achieved popularity.`,
        `Here's the mail it never fails`,
        `Detected popularity. Shall I put it on screen for you?`,
        `And now it's time for a word from our sponsor.`,
        `Got a message for you.`,
        `It's always a good day when @ posts`
    ];
    return `**${starboardHeaders[Math.floor(Math.random() * starboardHeaders.length)].replaceAll("@", msg.member?.nickname || msg.author?.globalName || msg.author?.username || "this person")}**`;
}

async function doEmojiboardReaction(react) {
    if (react.message.guildId == "0") return; // DMs patch

    const emoji = getEmojiFromMessage(
        react.emoji.requiresColons ?
            react.emoji.toString() :
            react.emoji.name
    );

    const guild = await guildByID(react.message.guildId);
    const emojiboards = guild.emojiboards;

    // exit if the emojiboard for this emoji is not setup
    if (!emojiboards.has(emoji)) return;

    const emojiboard = emojiboards.get(emoji);
    if (!emojiboard.active) return;
    const isGroupmute = emojiboard.isMute || guild.groupmute === emoji;

    if (!emojiboard.posted) {
        emojiboard.posted = new Map();
    }

    if (isGroupmute && emojiboard.posted.has(react.message.id)) {
        return;
    }

    // Exit conditions
    if (!isGroupmute) {
        // exit if this message has already been posted
        if (emojiboard.posted.has(react.message.id)) return;

        // Exit if the message is already an emojiboard post
        if (react.message.channel.id === emojiboard.channel) return;
    }

    const messageData = await react.message.channel.messages.fetch(react.message.id);
    const foundReactions = messageData.reactions.cache.get(react.emoji.id || react.emoji.name);
    const selfReactions = react.message.reactions.cache.filter(r => r.users.cache.has(react.message.author.id) && r.emoji.name === react.emoji.name);

    // exit if we haven't reached the threshold
    if ((emojiboard.threshold + selfReactions.size) > foundReactions?.count) {
        return;
    }

    if (isGroupmute) {
        var member = messageData.guild.members.cache.get(messageData.author.id);
        if (member === null || member === undefined) {
            member = await messageData.guild.members.fetch(messageData.author.id);
        }
        if (member === null || member === undefined) {
            return;
        }

        var botMember = messageData.guild.members.cache.get(client.user.id);
        if (botMember === null || botMember === undefined) {
            botMember = await messageData.guild.members.fetch(client.user.id).catch(() => null);
        }

        if (!member.moderatable || !botMember?.permissions.has(PermissionFlagsBits.ModerateMembers) || member.bot || member.permissions.has(PermissionFlagsBits.Administrator)) {
            return;
        }

        const timeoutLength = typeof emojiboard.length === "number" && emojiboard.length > 0
            ? emojiboard.length
            : 60000 * 5;
        const crowdmuteTTL = typeof emojiboard.ttl === "number" && emojiboard.ttl >= 0
            ? emojiboard.ttl
            : 60000 * 5;

        if (crowdmuteTTL > 0 && (Date.now() - messageData.createdTimestamp) > crowdmuteTTL) {
            return;
        }

        if (member.communicationDisabledUntilTimestamp > Date.now()) {
            return;
        }

        const timeoutApplied = await member.timeout(timeoutLength, `I was configured with /groupmute_config to do so.`)
            .then(() => true)
            .catch(() => false);

        if (!timeoutApplied) {
            return;
        }

        const durationText = ms(timeoutLength, { long: true }) || `${Math.round(timeoutLength / 1000)} seconds`;
        const replyMessage = await messageData.reply({
            content: `This user has been crowdmuted on this message for ${durationText}.`,
            allowedMentions: { parse: [] }
        }).catch(() => null);

        emojiboard.posted.set(react.message.id, replyMessage?.id || react.message.id);
        await guild.save();

        return;//If it's a groupmute, don't bother with emojiboard stuff.
    }

    var replyBlip = "";
    if (messageData.type === 19) {
        try {
            var refMessage = await messageData.fetchReference();
            replyBlip = `_[Reply to **${refMessage.author.username}**: ${refMessage.content.slice(0, 22).replace(/(https?:\/\/|\n)/ig, "")}${refMessage.content.length > 22 ? "..." : ""}](<https://discord.com/channels/${refMessage.guild.id}/${refMessage.channel.id}/${refMessage.id}>)_`;
        }
        catch { }
    }

    const resp = { files: [] };
    var i = 0;
    react.message.attachments.forEach((attached) => {
        let url = attached.url.toLowerCase();
        if (i !== 0 || (!url.includes(".jpg") && !url.includes(".png") && !url.includes(".jpeg") && !url.includes(".gif")) || emojiboard.messType === "0") {
            resp.files.push(attached.url);
        }
        i++;
    });

    if (emojiboard.messType === "0") {
        resp.content = react.message.content;
        resp.username = react.message.author.globalName || react.message.author.username;
        resp.avatarURL = react.message.author.displayAvatarURL();
        const c = client.channels.cache.get(emojiboard.channel);
        if (!c || !("guild" in c) || !c.isTextBased?.()) return; // TODO: if this is set poorly, disable
        if (!c.guild?.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageWebhooks)) {
            emojiboard.messType = "2";
            guild.save();
            return;
        }
        if (!("fetchWebhooks" in c)) return;
        let webhooks = await c.fetchWebhooks();
        let hook = webhooks.find(h => h.token);
        if (hook) {
            let response = await hook.send({
                ...resp,
                allowedMentions: { parse: [] }
            });
            emojiboard.posted.set(react.message.id, `webhook${response.id}`);
        }
        else {
            const fallbackChannel = client.channels.cache.get(emojiboard.channel);
            if (!fallbackChannel || !fallbackChannel.isTextBased?.()) return;
            if (!("createWebhook" in fallbackChannel)) return;

            const fallbackHook = await fallbackChannel.createWebhook({
                name: config.name,
                avatar: config.pfp
            });

            let response = await fallbackHook.send({
                ...resp,
                allowedMentions: { parse: [] }
            });

            emojiboard.posted.set(react.message.id, `webhook${response.id}`);
        }
    }
    else {
        const emojiURL = (
            react.emoji.requiresColons ?
                (
                    react.emoji.animated ?
                        `https://cdn.discordapp.com/emojis/${react.emoji.id}.gif` :
                        `https://cdn.discordapp.com/emojis/${react.emoji.id}.png`
                ) :
                undefined
        );

        resp.embeds = [new EmbedBuilder()
            .setColor(0x006400)
            .setTitle("(Jump to message)")
            .setURL(`https://www.discord.com/channels/${react.message.guild.id}/${react.message.channel.id}/${react.message.id}`)
            .setAuthor({
                name: react.message.author.globalName || react.message.author.username,
                iconURL: react.message.author.displayAvatarURL(),
                url: `https://discord.com/users/${react.message.author.id}`
            })
            .setDescription(`${replyBlip ? `${replyBlip}\n` : ""}${react.message.content ? react.message.content : "⠀"}`)
            .setTimestamp(new Date(react.message.createdTimestamp))
            .setFooter({
                text: `${!emojiURL ? react.emoji.name + " " : ""}${react.message.channel.name}`,
                iconURL: emojiURL
            })
            .setImage(react.message.attachments.first() ? react.message.attachments.first().url : null)
        ];
        if (emojiboard.messType === "1") {
            resp.content = getStarMsg(react.message);
        }
        const c = client.channels.cache.get(emojiboard.channel);
        if (!c || !("permissionsFor" in c) || !c.isTextBased?.()) return;
        if (!c.permissionsFor(client.user.id).has(PermissionFlagsBits.ManageWebhooks)) {
            emojiboard.active = false;
            guild.save();
            return;
        }
        const d = await c.send(resp);
        emojiboard.posted.set(react.message.id, d.id);
    }

    if (!guild.emojiboards.get(emoji).posters.get(react.message.author.id)) {
        guild.emojiboards.get(emoji).posters.set(react.message.author.id, 0);
    }

    guild.emojiboards.get(emoji).posters.set(react.message.author.id, guild.emojiboards.get(emoji).posters.get(react.message.author.id) + 1);
    guild.save();
}

/** @type {import("../command-module").CommandModule} */
module.exports = {
    getStarMsg,
    getEmojiFromMessage,
    doEmojiboardReaction,
    parseEmoji,

    data: {
        // Slash command data
        command: new SlashCommandBuilder()
            .setContexts(
                IT.Guild          // Server command
                // IT.BotDM,          // Bot's DMs
                // IT.PrivateChannel, // User commands
            )
            .setIntegrationTypes(
                AT.GuildInstall   // Install to servers
                // AT.UserInstall     // Install to users
            )
            .setName("emojiboard")
            .setDescription("Manage emojiboards for this server")
            .addSubcommand(subcommand =>
                subcommand
                    .setName("add")
                    .setDescription("Create a new emojiboard")
                    .addStringOption(option =>
                        option.setName("emoji").setDescription("The emoji to react with to trigger the emojiboard")
                            .setRequired(true)
                    )
                    .addChannelOption(option =>
                        option.setName("channel").setDescription("The channel to post the emojiboard in")
                            .addChannelTypes(ChannelType.GuildText)
                            .setRequired(true)
                    )
                    .addIntegerOption(option =>
                        option.setName("threshold").setDescription("How many reactions are needed to trigger starboard? (Default: 3)")
                            .setMinValue(1)
                    )
                    .addStringOption(option =>
                        option.setName("message_type").setDescription("What should the bot's starboard posts look like?")
                            .addChoices(
                                { "name": "Make it look like the user posted", "value": "0" },
                                { "name": "Post an embed with the message and a greeting", "value": "1" },
                                { "name": "Post an embed with the message", "value": "2" }
                            )
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("remove")
                    .setDescription("Remove an emojiboard")
                    .addStringOption(option =>
                        option.setName("emoji").setDescription("The emoji to remove the emojiboard for")
                            .setRequired(true)
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("edit")
                    .setDescription("Configure an emojiboard")
                    .addStringOption(option =>
                        option.setName("emoji").setDescription("The emojiboard to edit")
                            .setRequired(true)
                    )
                    .addBooleanOption(option =>
                        option.setName("active").setDescription("Should I post messages to the configured channel?")
                    )
                    .addChannelOption(option =>
                        option.setName("channel").setDescription("The channel to post messages to")
                            .addChannelTypes(ChannelType.GuildText)
                    )
                    .addIntegerOption(option =>
                        option.setName("threshold").setDescription("How many reactions are needed to trigger starboard?")
                            .setMinValue(1)
                    )
                    .addStringOption(option =>
                        option.setName("message_type").setDescription("What should the bot's starboard posts look like?")
                            .addChoices(
                                { "name": "Make it look like the user posted", "value": "0" },
                                { "name": "Post an embed with the message and a greeting", "value": "1" },
                                { "name": "Post an embed with the message", "value": "2" }
                            )
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("view")
                    .setDescription("View all active emojiboards and their settings")
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

        // Optional fields
        requiredGlobals: [],

        help: {
            helpCategories: [Categories.General, Categories.Configuration, Categories.Entertainment, Categories.Server_Only],
            shortDesc: "Manage emojiboards for this server",
            detailedDesc:
                `Manage emojiboards for Stewbot to run. If the emoji you choose is reacted enough times on a message (configurable threshold), then it will be posted to a highlights reel channel of your choosing.\n
				You can choose if Stewbot should display a random message and an embed with the message, just an embed with the message, or use webhooks to appear as if the user who originally made the post in question posted it there themselves.\n
				Use the subcommands to add, remove, edit, or view emojiboards.`
        }
    },

    async execute(cmd, context) {
        applyContext(context);

        if (!cmd.guild) {
            cmd.followUp("This command requires a server");
            return;
        }

        const subcommand = cmd.options.getSubcommand();
        const guild = await guildByObj(cmd.guild);

        switch (subcommand) {
            case "add":
                await this.executeAdd(cmd, guild);
                break;
            case "remove":
                await this.executeRemove(cmd, guild);
                break;
            case "edit":
                await this.executeEdit(cmd, guild);
                break;
            case "view":
                await this.executeView(cmd, guild);
                break;
        }
    },

    async executeAdd(cmd, guild) {
        var emoji = getEmojiFromMessage(cmd.options.getString("emoji"));
        if (!emoji) {
            cmd.followUp("That emoji is not valid.");
            return;
        }
        if (guild.groupmute === emoji) {
            cmd.followUp(`That emoji is in use for groupmute.`);
            return;
        }
        if (guild.emojiboards.has(emoji)) {
            cmd.followUp(`That emoji already has an emojiboard.`);
            return;
        }
        guild.emojiboards.set(emoji, {
            channel: cmd.options.getChannel("channel").id,
            active: true,
            threshold: cmd.options.getInteger("threshold") || 3,
            messType: cmd.options.getString("message_type"),
            posted: {},
            posters: {}
        });
        await guild.save();

        cmd.followUp("Emojiboard for " + parseEmoji(emoji) + " emoji added.");
    },

    async executeRemove(cmd, guild) {
        var emoji = getEmojiFromMessage(cmd.options.getString("emoji"));
        if (!emoji) {
            cmd.followUp("That emoji is not valid.");
            return;
        }

        if (!guild.emojiboards.has(emoji) || guild.emojiboards.get(emoji).isMute) {
            cmd.followUp("That emoji is not in use for an emojiboard.");
            return;
        }

        guild.emojiboards.delete(emoji);
        cmd.followUp("Emojiboard for " + parseEmoji(emoji) + " emoji removed.");

        guild.save();
    },

    async executeEdit(cmd, guild) {
        var emoji = getEmojiFromMessage(cmd.options.getString("emoji"));
        if (!emoji) {
            cmd.followUp("That emoji is not valid.");
            return;
        }

        if (!guild.emojiboards.has(emoji) || guild.emojiboards.get(emoji).isMute) {
            cmd.followUp("That emoji is not in use for an emojiboard.");
            return;
        }

        if (cmd.options.getBoolean("active") !== null) guild.emojiboards.get(emoji).active = cmd.options.getBoolean("active");
        if (cmd.options.getChannel("channel") !== null) guild.emojiboards.get(emoji).channel = cmd.options.getChannel("channel").id;
        if (cmd.options.getInteger("threshold") !== null) guild.emojiboards.get(emoji).threshold = cmd.options.getInteger("threshold");
        if (cmd.options.getString("message_type") !== null) guild.emojiboards.get(emoji).messType = cmd.options.getString("message_type");

        await guild.save();
        await cmd.followUp("Emojiboard for " + parseEmoji(emoji) + " emoji edited.");
    },

    async executeView(cmd, guild) {
        const emojiboards = Array.from(guild.emojiboards.entries()).filter(([_, board]) => !board.isMute);

        if (emojiboards.length === 0) {
            cmd.followUp("No emojiboards are currently configured for this server.");
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle("Emojiboards for " + cmd.guild.name)
            .setColor(0x006400);

        const messageTypeNames = {
            "0": "Webhook (as user)",
            "1": "Embed with greeting",
            "2": "Embed only"
        };

        let description = "";
        for (const [emoji, board] of emojiboards) {
            const channel = cmd.guild.channels.cache.get(board.channel);
            const channelMention = channel ? `<#${board.channel}>` : `Unknown Channel (${board.channel})`;
            const messageType = messageTypeNames[board.messType] || "Unknown";
            const status = board.active ? "Active" : "Inactive";

            description += `**${parseEmoji(emoji)}** - ${status}\n`;
            description += `   Channel: ${channelMention}\n`;
            description += `   Threshold: ${board.threshold} reactions\n`;
            description += `   Message Type: ${messageType}\n`;
            description += `   Posts: ${Object.keys(board.posted || {}).length}\n\n`;
        }

        embed.setDescription(description);
        cmd.followUp({ embeds: [embed] });
    },

    async [Events.MessageReactionAdd](react) {
        if (!react.message.guildId) return;

        // OPTIMIZE: we can save a DB query on reactions if we make this use the passed readonly guild.
        doEmojiboardReaction(react);
    },

    async [Events.MessageDelete](msg) {
        // Emojiboard deleted handlers
        const postToRedact = await Guilds.aggregate([
            // Find which emojiboard contains this posted msg ID
            {
                $project: {
                    emojiboards: {
                        $objectToArray: "$emojiboards"
                    }
                }
            },
            {
                $unwind: "$emojiboards"
            },
            {
                $match: {
                    [`emojiboards.v.posted.${msg.id}`]: {
                        $exists: true
                    }
                }
            },
            {
                $project: {
                    emoji: "$emojiboards.k",
                    board: "$emojiboards.v"
                }
            }
        ]);

        postToRedact.forEach(async ({ emoji, board }) => {
            if (emoji) {
                if (board?.isMute || !board?.channel) return;

                try {
                    const channel = await client.channels.fetch(board.channel);
                    if (!channel?.isTextBased?.()) return;
                    const messageId = board.posted[msg.id].replace("webhook", ""); // Webhook posts are formatted like `webhook${id}`
                    const messageToDelete = await channel.messages.fetch(messageId);

                    if (messageToDelete.editable) {
                        await messageToDelete.edit({ content: `I'm sorry, but it looks like this post by **${msg.author?.globalName || msg.author?.username}** was deleted.`, embeds: [], files: [] });
                        return;
                    }

                    // Otherwise delete it (webhooks for example)
                    else if (messageToDelete.deletable) {
                        await messageToDelete.delete();
                        return;
                    }
                }
                catch {
                    // Cache issues, nothing we can do
                }
            }
        });
    }
};
