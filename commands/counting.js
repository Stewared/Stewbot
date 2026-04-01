// #region CommandBoilerplate
const Categories = require("./modules/Categories");
const client = require("../client.js");
const { GuildUsers, guildByObj, guildUserByObj } = require("./modules/database.js");
const { Events, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");
function applyContext(context = {}) {
    for (let key in context) {
        this[key] = context[key];
    }
}

// #endregion CommandBoilerplate

/** @type {import("compromise").default} */
// @ts-ignore - Compromise ts checking is broken
const nlp = require("compromise");

const mathjs = require("mathjs");
const { canUseRole } = require("../utils.js");

function processForNumber(text) {
    text = text?.toLowerCase() || "";

    const text2MathMap = {
        "plus": "+",
        "minus": "-",
        "times": "*",
        "multiplied by": "*",
        "divided by": "/",
        "to the power of": "^",
        "squared": "^2",
        "cubed": "^3"
    };

    // Temporarily replace " - " or "-" with a unique marker
    text = text.replace(/(\s*-\s+)|(\s+-\s*)/g, " __HYD__ ");  // Replace spaces around hyphen or just hyphen
    text = text.replace(/(\s*minus\s+)|(\s+minus\s*)/g, " __HYD__ ");

    var doc = nlp(text);
    doc.numbers().toNumber();
    text = doc.text();

    for (let [word, symbol] of Object.entries(text2MathMap)) {
        text = text.replace(new RegExp(`\\b${word}\\b`, "g"), symbol);
    }

    text = text.replace(/__HYD__/g, "-");

    // Extract equation as far up as is possible
    text = text.match(/^([0-9+\-*/^()\s.]|sqrt)+/, "")?.[0]?.trim() || "";

    try {
        let result = +mathjs.evaluate(text);
        if (result) {
            return +result.toFixed(1);
        }
    }
    catch {
        return null;
    }
    return null;
}


/** @type {import("../command-module").CommandModule} */
module.exports = {
    processForNumber,

    data: {
        // Slash command data
        command: new SlashCommandBuilder().setName("counting")
            .setDescription("Manage counting functions for this server")
            .addSubcommand(command =>
                command.setName("config").setDescription("Configure counting for this server")
                    .addBooleanOption(option =>
                        option.setName("active").setDescription("Do counting things in this server?")
                            .setRequired(true)
                    )
                    .addChannelOption(option =>
                        option.setName("channel").setDescription("Channel to count in")
                            .addChannelTypes(ChannelType.GuildText)
                    )
                    .addBooleanOption(option =>
                        option.setName("reset").setDescription("Reset the count if a wrong number is posted (True to be on leaderboard)")
                    )
                    .addBooleanOption(option =>
                        option.setName("public").setDescription("Do you want this server to show up in the counting leaderboard?")
                    )
                    .addIntegerOption(option =>
                        option.setName("posts_between_turns").setDescription("How many posts do you need to wait between turns?")
                            .setMinValue(0)
                    )
                    .addBooleanOption(option =>
                        option.setName("apply-a-fail-role").setDescription("Should I apply a role to users who fail the count?")
                    )
                    .addRoleOption(option =>
                        option.setName("fail-role").setDescription("If fail roles are on, which role should be applied?")
                    )
                    .addBooleanOption(option =>
                        option.setName("apply-a-warn-role").setDescription("Should I apply a role to users who are warned?")
                    )
                    .addRoleOption(option =>
                        option.setName("warn-role").setDescription("If warn roles are on, which role should be applied?")
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(command =>
                command.setName("set_number").setDescription("Set the next number to count at (Disqualifies from leaderboard)")
                    .addIntegerOption(option =>
                        option.setName("num").setDescription("The number to count at next")
                            .setRequired(true)
                            .setMinValue(0)
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

        // Optional fields

        extra: { "contexts": [0], "integration_types": [0] },

        requiredGlobals: [],

        help: {
            config: {
                helpCategories: [Categories.General, Categories.Entertainment, Categories.Administration, Categories.Server_Only],
                shortDesc: "Configure counting for this server",
                detailedDesc:
                    `Configure the counting game here. To play, simply enter the next number in the sequence without messing up. You can configure that users need to wait a specific number of turns. The goal is to become the highest on the leaderboard.`
            },
            set_number: {
                helpCategories: [Categories.General, Categories.Entertainment, Categories.Administration, Categories.Server_Only],
                shortDesc: "Set the next number to count at",
                detailedDesc:
                    `Sets the next number for you to count at. If the number you choose is greater than one, this will disqualify the server from the leaderboard until a reset.`
            }
        }
    },

    async execute(cmd, context) {
        applyContext(context);

        // Permissions checking for roles:
        for (const role of [cmd.options.getRole("warn-role"), cmd.options.getRole("fail-role")]) {
            if (!role) continue;
            const [canUse, error] = await canUseRole(cmd.user, role, cmd.channel);
            if (!canUse) {
                return cmd.followUp(error);
            };
        }

        const guild = await guildByObj(cmd.guild);

        switch (cmd.options.getSubcommand()) {
            case "config":

                // If anything was made more "legit", reset the count to 0
                let resetJustSet = false;
                let turnsJustLegit = false;
                if (cmd.options.getBoolean("reset") && !guild.counting.reset) {
                    guild.counting.nextNum = 1;
                    guild.counting.lastValidCountMessageId = "";
                    resetJustSet = true;
                }
                if (cmd.options.getBoolean("reset") !== null) guild.counting.reset = cmd.options.getBoolean("reset");

                // If resetting is on and post between turns is enabled, reset the count so it can be legit
                if (cmd.options.getInteger("posts_between_turns") >= 1 && guild.counting.takeTurns < 1 && guild.counting.reset) {
                    guild.counting.nextNum = 1;
                    guild.counting.lastValidCountMessageId = "";
                    turnsJustLegit = true;
                }

                guild.counting.active = cmd.options.getBoolean("active");
                if (cmd.options.getChannel("channel") !== null) {
                    guild.counting.channel = cmd.options.getChannel("channel").id;
                    guild.counting.lastValidCountMessageId = "";
                }
                if (cmd.options.getBoolean("public") !== null) guild.counting.public = cmd.options.getBoolean("public");
                if (cmd.options.getInteger("posts_between_turns") !== null) guild.counting.takeTurns = cmd.options.getInteger("posts_between_turns");
                if (cmd.options.getBoolean("apply-a-fail-role") !== null) guild.counting.failRoleActive = cmd.options.getBoolean("apply-a-fail-role");
                if (cmd.options.getBoolean("apply-a-warn-role") !== null) guild.counting.warnRoleActive = cmd.options.getBoolean("apply-a-warn-role");
                if (cmd.options.getRole("fail-role") !== null) guild.counting.failRole = cmd.options.getRole("fail-role")?.id;
                if (cmd.options.getRole("warn-role") !== null) guild.counting.warnRole = cmd.options.getRole("warn-role")?.id;

                // Verification checks and permissions
                var disclaimers = [];
                if (guild.counting.failRoleActive) {
                    let fr = cmd.guild.roles.cache.get(guild.counting.failRole);
                    if (!fr) {
                        disclaimers.push("I was unable to identify the configured fail role, so fail roles have been turned off.");
                        guild.counting.failRoleActive = false;
                    }
                    if (!cmd.guild.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageRoles)) {
                        disclaimers.push("I do not have the MANAGE ROLES permission for this server, so I have turned off the fail roles.");
                        guild.counting.failRoleActive = false;
                    }
                    if (cmd.guild.members.cache.get(client.user.id).roles.highest.position <= fr.rawPosition) {
                        disclaimers.push("I do not have permission to manage the specified fail role, so fail roles have been turned off. Make sure that my highest role is dragged above the roles you want me to manage in the role settings.");
                        guild.counting.failRoleActive = false;
                    }
                }
                if (guild.counting.warnRoleActive) {
                    let wr = cmd.guild.roles.cache.get(guild.counting.warnRole);
                    if (!wr) {
                        disclaimers.push("I was unable to identify the configured warn role, so warn roles have been turned off.");
                        guild.counting.warnRoleActive = false;
                    }
                    if (!cmd.guild.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageRoles)) {
                        disclaimers.push("I do not have the MANAGE ROLES permission for this server, so I have turned off the warn roles.");
                        guild.counting.warnRoleActive = false;
                    }
                    if (cmd.guild.members.cache.get(client.user.id).roles.highest.position <= wr.rawPosition) {
                        disclaimers.push("I do not have permission to manage the specified warn role, so warn roles have been turned off. Make sure that my highest role is dragged above the roles you want me to manage in the role settings.");
                        guild.counting.warnRoleActive = false;
                    }
                }
                if (!guild.counting.channel) {
                    guild.counting.active = false;
                    disclaimers.push(`No channel was set for counting to be active in, so counting is disabled currently.`);
                }
                var c = await client.channels.fetch(guild.counting.channel);
                if (!("permissionsFor" in c) || !c?.permissionsFor(client.user.id)?.has(PermissionFlagsBits.SendMessages)) {
                    guild.counting.active = false;
                    disclaimers.push(`I can't send messages in the specified channel, so counting is disabled currently.`);
                }
                else if (!c?.permissionsFor(client.user.id)?.has(PermissionFlagsBits.AddReactions)) {
                    guild.counting.active = false;
                    disclaimers.push(`I can't add reactions in the specified channel, so counting is disabled currently.`);
                }

                // Check whether the config is legit
                if (!guild.counting.reset || guild.counting.takeTurns < 1) {
                    guild.counting.legit = false;
                }
                else {
                    // Now that we reset the count to 0 when resetting, it's safe to call it legit here.
                    guild.counting.legit = true;
                }

                await cmd.followUp(`Alright, I configured counting for this server.${
                    disclaimers.map(d => `\n\n${d}`).join("")
                }${
                    resetJustSet
                        ? "\nBecause you just enabled `reset`, the count has been set to 1."
                        : ""
                }
                    ${
                        turnsJustLegit
                            ? "\nBecause you just set `posts_between_turns` and reset is enabled, the count has been reset."
                            : ""
                    }${
                        guild.counting.legit
                            ? ""
                            : `\n-# Please be aware this server is currently ineligible for the leaderboard. To fix this, make sure that reset is set to true, that the posts between turns is at least 1, and that you don't set the number to anything higher than 1 manually.`
                    }`
                );
                break;

            case "set_number":
                if (!guild.counting.active) {
                    cmd.followUp(`This server doesn't use counting at the moment, configure it with ${cmds["counting config"]}.`);
                    break;
                }
                guild.counting.nextNum = cmd.options.getInteger("num");
                guild.counting.lastValidCountMessageId = "";
                if (guild.counting.nextNum > 1) {
                    guild.counting.legit = false;
                }
                else if (guild.counting.reset && guild.counting.takeTurns > 0) {
                    guild.counting.legit = true;
                }
                cmd.followUp(`Alright, I've set the next number to be counted to \`${guild.counting.nextNum}\`.${guild.counting.legit ? "" : `\n\n-# Please be aware that this server is currently ineligible for the leaderboard. To fix this, make sure that the number you start from is less than 2, that the posts between turns is at least 1, and that counting is configured to reset upon any mistakes.`}`);
                break;
        }

        guild.save();
    },

    /**
     * @param {import('discord.js').Message} msg
     * @param {import("./modules/database.js").GuildDoc} guildStore
     * */
    async [Events.MessageCreate](msg, context, guildStore) {
        if (!msg.guild) return;
        applyContext(context);

        let guild = guildStore; //await guildByObj(msg.guild);
        let guildCounting = guild.counting;

        let guildUser;

        // Counting
        if (!msg.author.bot && guildCounting.active && msg.channel.id === guildCounting.channel) {

            // Fetch the full guild object for simplicity - TODO_DB: this could be made more efficient
            let guild = await guildByObj(msg.guild);
            let guildCounting = guild.counting;
            guildCounting.lastValidCountMessageId ??= "";

            // Fetch the guild user's doc if we're counting
            guildUser = await guildUserByObj(msg.guild, msg.author.id);
            if (!guildUser) return;

            // If the server uses counting, but Stewbot cannot add reactions or send messages, don't do counting
            if (
                !("permissionsFor" in msg.channel) ||
                !msg.channel.permissionsFor(client.user.id).has(PermissionFlagsBits.AddReactions) ||
                !msg.channel.permissionsFor(client.user.id).has(PermissionFlagsBits.SendMessages)
            ) {
                guildCounting.active = false;
                await guild.save();
                return;
            }

            var num = processForNumber(msg.content);
            if (num) {
                if (num === guildCounting.nextNum) {
                    if (guildUser.countTurns <= 0) {

                        // Discord glitches if the reaction is added too quickly
                        setTimeout(_ => {
                            // user could have blocked, a bot could have deleted it faster, etc...
                            msg.react("✅").catch(_ => {});
                        }, 150);

                        guildCounting.nextNum++;
                        guildCounting.lastValidCountMessageId = msg.id;
                        if (guildCounting.legit && num > guildCounting.highestNum) {
                            msg.react("🎉");
                            guildCounting.highestNum = num;
                        }

                        // Reduce the turns of all other users
                        await GuildUsers.updateMany(
                            { guildId: msg.guild.id, countTurns: { $gt: 0 } },
                            { $inc: { countTurns: -1 } }
                        );

                        guildUser.countTurns = guildCounting.takeTurns;
                    }
                    else {
                        msg.react("❌");
                        if (guildUser.beenCountWarned && guildCounting.reset) {
                            msg.reply(`⛔ **Reset**\nNope, you need to wait for ${guildCounting.takeTurns} other ${guildCounting.takeTurns === 1 ? "person" : "people"} to post before you post again!${guildCounting.reset ? ` The next number to post was going to be \`${guildCounting.nextNum}\`, but now it's \`1\`.` : ""}`);
                            if (guildCounting.reset) {
                                guildCounting.nextNum = 1;
                                guildCounting.lastValidCountMessageId = "";
                                if (guildCounting.reset && guildCounting.takeTurns > 0) guildCounting.legit = true;

                                await GuildUsers.updateMany(
                                    { guildId: msg.guild.id, countTurns: { $gt: 0 } },
                                    { $set: { countTurns: 0 } }
                                );

                                if (guildCounting.failRoleActive && msg.guild.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageRoles)) {
                                    let fr = msg.guild.roles.cache.get(guildCounting.failRole);
                                    if (fr === null || fr === undefined) {
                                        guildCounting.failRoleActive = false;
                                    }
                                    else {
                                        if (msg.guild.members.cache.get(client.user.id).roles.highest.position > fr.rawPosition) {
                                            try { await msg.member.roles.add(fr); }
                                            catch { }
                                        }
                                        else {
                                            guildCounting.failRoleActive = false;
                                        }
                                    }
                                }

                            }
                        }
                        else {
                            msg.reply(`# ⚠️ **Warning**\n## The Next Number Is: \`${guildCounting.nextNum}\`\n\nThat was incorrect. You have been warned! Next time this will reset the count. The next number is **${guildCounting.nextNum}**.\`\`\`\nNumbers entered must be the last number plus one, (so if the last entered number is 148, the next number is 149).${guildCounting.takeTurns > 0 ? ` You also need to make sure at least ${guildCounting.takeTurns} other ${guildCounting.takeTurns === 1 ? "person" : "people"} take${guildCounting.takeTurns === 1 ? "s" : ""} a turn before you take another turn.\`\`\`\n\nYou did not wait out a sufficient amount of turns before posting a second time.` : "```"}`);
                            guildUser.beenCountWarned = true;
                            if (guildCounting.warnRoleActive && msg.guild.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageRoles)) {
                                let wr = msg.guild.roles.cache.get(guildCounting.warnRole);
                                if (wr === null || wr === undefined) {
                                    guildCounting.warnRoleActive = false;
                                }
                                else {
                                    if (msg.guild.members.cache.get(client.user.id).roles.highest.position > wr.rawPosition) {
                                        try { await msg.member.roles.add(wr); }
                                        catch { }
                                    }
                                    else {
                                        guildCounting.warnRoleActive = false;
                                    }
                                }
                            }

                        }
                    }
                }
                else if (guildCounting.reset && guildCounting.nextNum !== 1) {
                    msg.react("❌");
                    if (guildUser.beenCountWarned && guildCounting.reset) {
                        msg.reply(`⛔ **Reset**\nNope, that was incorrect! The next number to post was supposed to be \`${guildCounting.nextNum}\`, but now it's \`1\`.`);
                        guildCounting.nextNum = 1;
                        guildCounting.lastValidCountMessageId = "";

                        if (guildCounting.reset && guildCounting.takeTurns > 0)
                            guildCounting.legit = true;

                        await GuildUsers.updateMany(
                            { guildId: msg.guild.id, countTurns: { $gt: 0 } },
                            { $set: { countTurns: 0 } }
                        );

                        if (guildCounting.failRoleActive && msg.guild.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageRoles)) {
                            let fr = msg.guild.roles.cache.get(guildCounting.failRole);
                            if (!fr) {
                                guildCounting.failRoleActive = false;
                            }
                            else {
                                if (msg.guild.members.cache.get(client.user.id).roles.highest.position > fr.rawPosition) {
                                    try { await msg.member.roles.add(fr); }
                                    catch { }
                                }
                                else {
                                    guildCounting.failRoleActive = false;
                                }
                            }
                        }

                    }
                    else {
                        msg.reply(
                            `# ⚠️ **Warning**\n` +
                            `## The Next Number To Post Is: \`${guildCounting.nextNum}\`\n\n`+
                            `Nope, that's incorrect. You have been warned! Next time this will reset the count. The next number is **${guildCounting.nextNum}**.` +
                            `\`\`\`\n` +
                            `Numbers entered must be the last number plus one, (so if the last entered number is 148, the next number is 149).` +
                                `${guildCounting.takeTurns > 0
                                    ? ` You also need to make sure at least ${guildCounting.takeTurns} other ${guildCounting.takeTurns === 1 ? "person" : "people"} take${guildCounting.takeTurns === 1 ? "s" : ""} a turn before you take another turn.\`\`\``
                                    : "```"
                                }\n\n`+
                            `Your mistake was posting the wrong number. Read: \`${num}\`.`
                        );

                        guildUser.beenCountWarned = true;

                        if (guildCounting.warnRoleActive && msg.guild.members.cache.get(client.user.id).permissions.has(PermissionFlagsBits.ManageRoles)) {
                            let wr = msg.guild.roles.cache.get(guildCounting.warnRole);
                            if (wr === null || wr === undefined) {
                                guildCounting.warnRoleActive = false;
                            }
                            else {
                                if (msg.guild.members.cache.get(client.user.id).roles.highest.position > wr.rawPosition) {
                                    try { await msg.member.roles.add(wr); }
                                    catch { }
                                }
                                else {
                                    guildCounting.warnRoleActive = false;
                                }
                            }
                        }
                    }
                }
            }

            await Promise.all([
                guildUser.save(),
                guild.save()
            ]);
        }
    },

    async [Events.MessageUpdate](_, msg, _readGuild) {
        if (msg.guild?.id === undefined || client.user.id === msg.author?.id) return; // Ignore self and DMs
        const guild = await guildByObj(msg.guild);
        const guildCounting = guild?.counting;
        if (!guildCounting?.active) return;
        // Counting edit handlers
        if (guildCounting.channel === msg.channel.id && guildCounting.lastValidCountMessageId === msg.id) {
            try {
                const expectedNum = Math.max(1, (guildCounting.nextNum ?? 1) - 1);
                const reposted = await msg.channel.send(String(expectedNum));
                await reposted.react("\u2705").catch(() => {});
                guildCounting.lastValidCountMessageId = reposted.id;
                await guild.save();
            }
            catch {}
        }
    },
    async [Events.MessageDelete](msg, _guildStore) {
        if (!msg.guild) return;
        const guild = await guildByObj(msg.guild);
        const guildCounting = guild?.counting;
        // Resend if the latest counting number was deleted
        if (guildCounting?.active && guildCounting.lastValidCountMessageId === msg.id) {
            try {
                const expectedNum = Math.max(1, (guildCounting.nextNum ?? 1) - 1);
                const reposted = await msg.channel.send(String(expectedNum));
                await reposted.react("\u2705").catch(() => {});
                guildCounting.lastValidCountMessageId = reposted.id;
                await guild.save();
            }
            catch { }
        }
    }
};
