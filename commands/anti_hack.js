// #region CommandBoilerplate
const Categories = require("./modules/Categories");
const client = require("../client.js");
const { guildByID, guildByObj, userByObj, guildUserByObj } = require("./modules/database.js");
const { Events, InteractionContextType: IT, ApplicationIntegrationType: AT, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags, AttachmentBuilder } = require("discord.js");
function applyContext(context = {}) {
    for (let key in context) {
        this[key] = context[key];
    }
}

// #endregion CommandBoilerplate

const { requireServer } = require("../utils.js");
const crypto = require("crypto");
const ms = require("ms");
const { messageIdToWarnings } = require("./badware_scanner.js");
const listFormatter = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
// const LRUCache = require("lru-cache").LRUCache;


// Store post hashes so we can catch repeat posts
const cache = {}; // TODO: lru cache
const CROSS_CHANNEL_WINDOW_MS = ms("10s");
const SAME_CONTENT_CROSS_CHANNEL_THRESHOLD = 3;
const ATTACHMENT_ONLY_CROSS_CHANNEL_THRESHOLD = 3;
const DANGER_KEYWORDS = ["@everyone", "@here", "http", "discordapp", "discord.gg", "discord.com"];

/**
 * Returns true when message content includes any high-risk spam indicator.
 * @param {string} content
 * */
function containsDangerKeyword(content) {
    const lowerContent = content.toLowerCase();
    return DANGER_KEYWORDS.some(keyword => lowerContent.includes(keyword));
}

/**
 * Track posts by fingerprint and detect cross-channel bursts in a short window.
 * @param {object} userCache
 * @param {string} key
 * @param {string} channelId
 * @param {number} threshold
 * */
function registerCrossChannelPost(userCache, key, channelId, threshold) {
    const now = Date.now();
    userCache.crossChannelPosts ??= {};

    // Prune stale entries from all tracked fingerprints to keep cache growth bounded.
    for (const trackedKey of Object.keys(userCache.crossChannelPosts)) {
        userCache.crossChannelPosts[trackedKey] = userCache.crossChannelPosts[trackedKey]
            .filter(entry => now - entry.timestamp <= CROSS_CHANNEL_WINDOW_MS);

        if (userCache.crossChannelPosts[trackedKey].length === 0) {
            delete userCache.crossChannelPosts[trackedKey];
        }
    }

    const history = userCache.crossChannelPosts[key] ?? [];
    const channelsBefore = new Set(history.map(entry => entry.channelId)).size;

    history.push({ channelId, timestamp: now });
    if (history.length > 30) history.splice(0, history.length - 30);

    userCache.crossChannelPosts[key] = history;

    const channelsAfter = new Set(history.map(entry => entry.channelId)).size;
    return {
        triggered: channelsAfter >= threshold,
        justTriggered: channelsBefore < threshold && channelsAfter >= threshold
    };
}

/**
 * Deletes a message and any warnings from the badware_scanner replying to it
 * @param {import('discord.js').Message} message
 * */
async function deleteMsgAndWarnings(message) {
    const replies = messageIdToWarnings.get(message.id) || [];

    await Promise.all([
        // Delete original message
        message.delete().catch(() => {}),

        // Delete all warning messages
        ...replies.map(async ({ channelId, messageId }) => {
            const channel = client.channels.cache.get(channelId);
            if (!channel?.isTextBased()) return;
            try {
                await channel.messages.delete(messageId);
            }
            catch {}
        })
    ]);
}

/** @type {import("../command-module").CommandModule} */
module.exports = {
    antiHackCache: cache,

    data: {
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
            .setName("anti_hack")
            .setDescription("Configure how hacked accounts are dealt with")
            .addBooleanOption(option =>
                option.setName("disable_anti_hack").setDescription("Do you want to disable the anti hack/spam account protection for this server?")
            )
            .addBooleanOption(option =>
                option.setName("log").setDescription("Whether to log incidents to a specific log channel instead of in public.")
            )
            .addChannelOption(option =>
                option.setName("log_channel").setDescription("The channel to log to")
            )
            .addBooleanOption(option =>
                option.setName("auto_delete").setDescription("Whether to automatically delete messages without moderator interaction.")
            )
            .addBooleanOption(option =>
                option.setName("private").setDescription("Make the response ephemeral?")
                    .setRequired(false)
            )
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.ManageMessages),

        // Not all modules will have help commands, but they can in theory to showcase bot features.
        help: {
            helpCategories: [Categories.Server_Only, Categories.Safety],
            shortDesc: "Defend server from hacked accounts.",
            detailedDesc: //Detailed on exactly what the command does and how to use it
                `This module watches for spam messages that look like they are from hacked accounts, and times out the user until they complete a captcha verification`
        }
    },

    async execute(cmd, context) {
        if (requireServer(cmd)) return;
        applyContext(context);

        const guild = await guildByID(cmd.guildId);

        if (cmd.options.getBoolean("auto_delete"))
            guild.config.antihack_auto_delete = cmd.options.getBoolean("auto_delete");

        if (cmd.options.getBoolean("disable_anti_hack") !== null)
            guild.disableAntiHack = cmd.options.getBoolean("disable_anti_hack");

        let log_channel = cmd.options.getChannel("log_channel");
        if (log_channel) {
            guild.config.antihack_log_channel = log_channel.id;
            guild.config.antihack_to_log = true; // Unless overridden, changing the log channel means enable logging
        }

        if (cmd.options.getBoolean("log") !== null)
            guild.config.antihack_to_log = cmd.options.getBoolean("log");

        await guild.save();

        cmd.followUp("Anti-Hack response configured.");
    },

    /**
     * @param {import('discord.js').Message} msg
     * @param {import("./modules/database.js").GuildDoc} guildStore
     * @param {import("./modules/database.js").GuildUserDoc} guildUserStore
     * */
    async [Events.MessageCreate](msg, context, guildStore, guildUserStore) {
        if (!msg.guild) return;

        const guild = guildStore;

        if (guild.disableAntiHack) return;
        applyContext(context);

        // Don't run in DMs
        if (!msg.member) return;

        // Config
        let toLog = guild.config.antihack_to_log || false;
        const logChannelId = toLog
            ? guild.config.antihack_log_channel || false
            : false;
        let autoDelete = guild.config.antihack_auto_delete;

        const userIsAdmin = msg.member.permissions.has(PermissionFlagsBits.Administrator);
        const userIsOwner = msg.guild.ownerId === msg.author.id;
        const timeoutable = msg.member.manageable && !userIsAdmin && !userIsOwner;

        // Anti-hack message
        if (msg.guild && !msg.author.bot) {
            // Create message data
            var hash = crypto.createHash("md5").update(msg.content.slice(0, 148))
                .digest("hex"); // TODO: use something faster than md5?

            // Make sure user / server is in cache
            cache[msg.guild.id] ??= {};
            cache[msg.guild.id].users ??= {};
            cache[msg.guild.id].users[msg.author.id] ??= {};
            cache[msg.guild.id].users[msg.author.id].lastMessages ??= [];
            cache[msg.author.id] ??= {};
            cache[msg.author.id].hashStreak ??= 0;
            cache[msg.author.id].crossChannelPosts ??= {};

            const trimmedContent = msg.content.trim();
            const isAttachmentOnly = trimmedContent.length === 0 && msg.attachments.size > 0;
            const hasDangerKeyword = containsDangerKeyword(msg.content);

            let sameContentCrossChannel = { triggered: false, justTriggered: false };
            let attachmentOnlyCrossChannel = { triggered: false, justTriggered: false };

            if (trimmedContent.length > 0 && hasDangerKeyword) {
                const contentHash = crypto.createHash("md5")
                    .update(trimmedContent.slice(0, 148))
                    .digest("hex");

                sameContentCrossChannel = registerCrossChannelPost(
                    cache[msg.author.id],
                    `content:${contentHash}`,
                    msg.channel.id,
                    SAME_CONTENT_CROSS_CHANNEL_THRESHOLD
                );
            }

            if (isAttachmentOnly) {
                attachmentOnlyCrossChannel = registerCrossChannelPost(
                    cache[msg.author.id],
                    "attachment-only",
                    msg.channel.id,
                    ATTACHMENT_ONLY_CROSS_CHANNEL_THRESHOLD
                );
            }

            const crossChannelDetected =
                sameContentCrossChannel.triggered || attachmentOnlyCrossChannel.triggered;

            if (cache[msg.author.id].lastHash === hash || crossChannelDetected) {
                // Keep existing hash-streak behavior for repeated risky content.
                if (cache[msg.author.id].lastHash === hash && hasDangerKeyword) cache[msg.author.id].hashStreak++;
                else if (cache[msg.author.id].lastHash !== hash) {
                    cache[msg.author.id].lastHash = hash;
                    cache[msg.author.id].hashStreak = 0;
                }

                const spamThreshold = 3;

                if (cache[msg.author.id].hashStreak >= spamThreshold || crossChannelDetected) {
                    // NOTE: To avoid spam when we only have delete perms, we only warn when this user hits a hash streak of 3.
                    const toNotify = (
                        cache[msg.author.id].hashStreak === spamThreshold ||
                        sameContentCrossChannel.justTriggered ||
                        attachmentOnlyCrossChannel.justTriggered
                    );
                    const timeoutReason = cache[msg.author.id].hashStreak >= spamThreshold
                        ? "Detected spam activity of high profile pings and/or a URL of some kind. Automatically applied for safety."
                        : sameContentCrossChannel.triggered
                            ? "Detected the same content posted across multiple channels in a short span. Automatically applied for safety."
                            : "Detected attachment-only posts across multiple channels in a short span. Automatically applied for safety.";

                    const user = await userByObj(msg.author);
                    const userInGuild = guildUserStore; //await guildUserByObj(msg.guild, msg.author.id);

                    // Handle this user
                    var botInServer = msg.guild?.members.cache.get(client.user.id);
                    const botHasTimeoutPermission = botInServer?.permissions?.has(PermissionFlagsBits.ModerateMembers) || false;
                    const canTimeoutUser = timeoutable && botHasTimeoutPermission;
                    if (
                        botInServer &&
                        !guild.disableAntiHack &&
                        // Users who complete captchas are marked as safe for a week.
                        Date.now() - (userInGuild.safeTimestamp || Date.now()) < ms("7d")
                    ) {
                        // Timeout if we have perms
                        if (canTimeoutUser) {
                            msg.member.timeout(
                                ms("1d"),
                                timeoutReason
                            ); //One day, by then any automated hacks should've run their course
                            user.timedOutIn.push(msg.guild.id);
                        }

                        const logChannel = logChannelId
                            ? await msg.guild.channels.fetch(logChannelId).catch(async () => {
                                // If this channel doesn't exist (was deleted), disable logging to it
                                await guildByObj(msg.guild, {
                                    "guild.config.antihack_log_channel": "",
                                    "guild.config.antihack_to_log": false
                                });

                                toLog = false;
                                return msg.channel;
                            })
                            : msg.channel;


                        // Post about this user in this channel
                        if (
                            logChannel?.isTextBased() &&
                            "permissionsFor" in logChannel &&
                            logChannel?.permissionsFor(client.user.id)?.has(PermissionFlagsBits.SendMessages)
                        ) {

                            // Build buttons based on what permissions the bot has over the user.
                            const sendRow = [];
                            const missingPermissions = [];

                            const botHasTimeoutPermission = botInServer.permissions.has(PermissionFlagsBits.ModerateMembers);
                            const botHasBanPermission = botInServer.permissions.has(PermissionFlagsBits.BanMembers);
                            const botHasKickPermission = botInServer.permissions.has(PermissionFlagsBits.KickMembers);
                            const botHasManageMessages = botInServer.permissions.has(PermissionFlagsBits.ManageMessages);

                            // Timeout button
                            if (canTimeoutUser) { // TODO: check this works
                                sendRow.push(new ButtonBuilder().setCustomId("untimeout-" + msg.author.id)
                                    .setLabel("Remove Timeout")
                                    .setStyle(ButtonStyle.Success));
                            }
                            else if (!botHasTimeoutPermission) missingPermissions.push("Timeout Members");

                            // Ban button
                            if (botHasBanPermission && msg.member.bannable) {
                                sendRow.push(new ButtonBuilder().setCustomId("ban-" + msg.author.id)
                                    .setLabel(`Ban`)
                                    .setStyle(ButtonStyle.Danger));
                            }
                            else if (!botHasBanPermission) missingPermissions.push("Ban Members");

                            // Kick button
                            if (botHasKickPermission && msg.member.kickable) {
                                sendRow.push(new ButtonBuilder().setCustomId("kick-" + msg.author.id)
                                    .setLabel(`Kick`)
                                    .setStyle(ButtonStyle.Danger));
                            }
                            else if (!botHasKickPermission) missingPermissions.push("Kick Members");

                            // Delete messages button
                            if (botHasManageMessages) {
                                if (autoDelete) {
                                    // Delete without asking
                                    for (var i = 0; i < cache[msg.guild.id].users[msg.author.id].lastMessages.length; i++) {
                                        try {
                                            let channel = client.channels.cache.get(
                                                cache[msg.guild.id].users[msg.author.id].lastMessages[i].split("/")[0]
                                            );
                                            if (!channel || !("messages" in channel)) continue;

                                            let badMess = await channel.messages?.fetch(
                                                cache[msg.guild.id].users[msg.author.id].lastMessages[i].split("/")[1]
                                            ).catch(() => null);
                                            deleteMsgAndWarnings(badMess).catch(() => { });
                                            // badMess.delete().catch(() => { });
                                        }
                                        catch (e) { console.log(e); }
                                    }

                                    // Finally, delete this current trigger message
                                    deleteMsgAndWarnings(msg);
                                    // msg.delete().catch(() => { });

                                    // Since they are deleted, now ignore them
                                    cache[msg.guild.id].users[msg.author.id].lastMessages = [];
                                }
                                else {
                                    sendRow.push(new ButtonBuilder().setCustomId("del-" + msg.author.id)
                                        .setLabel(`Delete the Messages in Question`)
                                        .setStyle(ButtonStyle.Primary));
                                }
                            }
                            else missingPermissions.push("Manage Messages");

                            // Build a message indicating
                            let missingPermissionsMessage = "";
                            if (missingPermissions.length > 0) {
                                const formattedMissing = listFormatter.format(missingPermissions.map(p => `\`${p}\``));
                                missingPermissionsMessage = `-# :warning: I am missing the ${formattedMissing} ${missingPermissions.length > 1 ? "permissions" : "permission"}, so some features are limited.`;
                            }

                            const timeoutIssues = [];

                            if (!botHasTimeoutPermission) timeoutIssues.push("I don't have the `Timeout Members` permission");
                            if (userIsOwner) timeoutIssues.push("the user is the server owner");
                            else if (userIsAdmin) timeoutIssues.push("the user is an administrator");
                            else if (!msg.member.manageable) timeoutIssues.push("my highest role is below theirs");

                            const timeoutIssueText = timeoutIssues.length > 0
                                ? listFormatter.format(timeoutIssues)
                                : "an unknown permission issue"; // If we can't and don't know why, it was some recent discord.js change.

                            const timeoutFixes = [];
                            if (!userIsOwner && !userIsAdmin) {
                                if (!botHasTimeoutPermission) timeoutFixes.push("granting me the `Timeout Members` permission");
                                if (!msg.member.manageable) timeoutFixes.push("placing my role above theirs");
                            }

                            let timeoutFixText = "";
                            if (timeoutFixes.length > 0) {
                                const formattedFixes = listFormatter.format(timeoutFixes);
                                timeoutFixText = ` ${formattedFixes.charAt(0).toUpperCase() + formattedFixes.slice(1)} would allow me to defend against spam and hacked accounts.`;
                            }

                            let timeoutAttemptMessage = canTimeoutUser
                                ? `I temporarily applied a timeout. To remove this timeout, <@${msg.author.id}> can use ${cmds.captcha.mention} in a DM with me.`
                                : `I tried to apply a timeout to this account but couldn't because ${timeoutIssueText}.${timeoutFixText}`;

                            let autoDeleteNotice = autoDelete
                                ? " which has since been automatically deleted"
                                : "";

                            // const components = [];

                            // if (sendRow.length > 0) {
                            //     components.push(
                            //         new ActionRowBuilder().addComponents(
                            //             ...sendRow
                            //         )
                            //     );
                            // }

                            // Warn, then delete the message afterwards so they see it was deleted
                            // if (toNotify) await logChannel.send({
                            //     content:
                            //         `I have detected unusual activity from <@${msg.author.id}>${autoDeleteNotice}. ${timeoutAttemptMessage}\n` +
                            //         `\n` +
                            //         `-# Configure detection in your server settings with ${cmds.anti_hack.mention}.` +
                            //         missingPermissionsMessage,
                            //     components: components.map(c => c.toJSON())
                            // });

                            const components = [
                                new ContainerBuilder()
                                    .addTextDisplayComponents(
                                        new TextDisplayBuilder().setContent("## Hacked Account Blocked")
                                    )
                                    .addSectionComponents(
                                        new SectionBuilder()
                                            .setThumbnailAccessory(
                                                new ThumbnailBuilder()
                                                    .setURL("attachment://antiHack.png")
                                            )
                                            .addTextDisplayComponents(
                                                new TextDisplayBuilder().setContent(
                                                    `I have detected unusual activity from <@${msg.author.id}>${autoDeleteNotice}. ${timeoutAttemptMessage}\n`
                                                )
                                            )
                                    )
                                    .addTextDisplayComponents(
                                        ...(missingPermissions.length > 0
                                            ? [new TextDisplayBuilder().setContent(missingPermissionsMessage)]
                                            : []
                                        )
                                    )
                                    .addSeparatorComponents(
                                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
                                            .setDivider(true)
                                    )
                                    .addTextDisplayComponents(
                                        new TextDisplayBuilder().setContent(`[Protect your server with Stewbot](${config.install})`)
                                    )
                                    .addSeparatorComponents(
                                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
                                            .setDivider(true)
                                    )
                                    .addTextDisplayComponents(
                                        new TextDisplayBuilder().setContent(`-# Control detection settings with ${cmds.anti_hack.mention}.`)
                                    )
                            ];

                            // if (sendRow.length > 0) components.push(
                            //     new ActionRowBuilder().addComponents(
                            //         ...sendRow
                            //     )
                            // );

                            if (toNotify) await logChannel.send({
                                components: components,
                                flags: MessageFlags.IsComponentsV2,
                                files: [new AttachmentBuilder("pfps/antiHack.png").setName("antiHack.png")]
                            });

                            // Finally, DM This user if the message was set to go to a log channel
                            if (toNotify && toLog) {
                                msg.author.send(
                                    `I have detected unusual activity from your account, you have been given a timeout in one or more servers.\n` +
                                    `To remove this timeout, you can use can use ${cmds.captcha.mention} in a DM with me.`
                                );
                            }
                        }
                    }

                    user.save();
                }
            }
            else {
                cache[msg.author.id].lastHash = hash;
                cache[msg.author.id].hashStreak = 0;
                cache[msg.guild.id].users[msg.author.id].lastMessages = [];
            }
            cache[msg.guild.id].users[msg.author.id].lastMessages.push(`${msg.channel.id}/${msg.id}`);
        }
    },

    // Only button subscriptions matched will be sent to the handler
    subscribedButtons: [/ban-.*/, /kick-.*/, /untimeout-.*/, /del-.*/],

    async onbutton(cmd, context) {
        if (!cmd.guild) return;
        if (!cmd.member || typeof(cmd.member.permissions) !== "object") return;

        const guild = await guildByObj(cmd.guild);

        if (guild.disableAntiHack) return cmd.reply({
            content: `AntiHack protection has been disabled for this server.`,
            ephemeral: true
        });

        applyContext(context);

        if (cmd.customId?.startsWith("ban-")) {
            if (cmd.member?.permissions.has(PermissionFlagsBits.BanMembers)) {
                let target = cmd.guild.members.cache.get(cmd.customId.split("-")[1]);
                if (target) {
                    target.ban({ reason: `Detected high spam activity with high profile pings and/or a URL, was instructed to ban by ${cmd.user.username}.` });
                    cmd.message.delete().catch(() => { });
                }
                else {
                    cmd.reply({ content: `I was unable to find the target in question.`, ephemeral: true });
                }
                if (cmd.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    for (let i = 0; i < cache[cmd.guild.id].users[cmd.customId.split("-")[1]].lastMessages.length; i++) {
                        try {
                            let channel = await client.channels.cache.get(
                                cache[cmd.guild.id].users[
                                    cmd.customId.split("-")[1]
                                ].lastMessages[i].split("/")[0]
                            );
                            if (!channel || !("messages" in channel)) continue;

                            let badMess = await channel.messages.fetch(
                                cache[cmd.guild.id].users[
                                    cmd.customId.split("-")[1]
                                ].lastMessages[i].split("/")[1]
                            );
                            deleteMsgAndWarnings(badMess);
                            // badMess.delete().catch(() => { });
                            cache[cmd.guild.id].users[cmd.customId.split("-")[1]].lastMessages.splice(i, 1);
                            i--;
                        }
                        catch (e) { console.log(e); }
                    }
                }
            }
            else {
                cmd.reply({ content: `You do not have sufficient permissions to ban members.`, ephemeral: true });
            }
        }

        if (cmd.customId?.startsWith("untimeout-")) {
            if (cmd.member?.permissions.has(PermissionFlagsBits.ModerateMembers)) {

                let target = await cmd.guild.members.fetch(cmd.customId.split("-")[1]).catch(_ => null);
                if (target) {
                    await guildUserByObj(cmd.guild, cmd.customId.split("-")[1], {
                        safeTimestamp: new Date()
                    });

                    target.timeout(null);
                    cmd.message.delete().catch(() => { });;
                }
                else {
                    cmd.reply({ content: `I was unable to find the target in question.`, ephemeral: true });
                }
            }
            else {
                cmd.reply({ content: `You do not have sufficient permissions to timeout members.`, ephemeral: true });
            }
        }

        if (cmd.customId?.startsWith("kick-")) {
            if (cmd.member.permissions.has(PermissionFlagsBits.KickMembers)) {
                let target = cmd.guild.members.cache.get(cmd.customId.split("-")[1]);
                if (target) {
                    target.kick(`Detected high spam activity with high profile pings and/or a URL, was instructed to kick by ${cmd.user.username}.`);
                    // await cmd.reply({content:`Done. Do you wish to delete the messages in question as well?`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("del-"+target.id).setLabel("Yes").setStyle(ButtonStyle.Success))],ephemeral:true});
                    await cmd.reply({ content: `Attempted to kick.`, ephemeral: true });
                    cmd.message.delete().catch(() => { });;
                }
                else {
                    cmd.reply({ content: `I was unable to find the target in question.`, ephemeral: true });
                }
                if (cmd.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    for (let i = 0; i < cache[cmd.guild.id].users[cmd.customId.split("-")[1]].lastMessages.length; i++) {
                        try {
                            var channel = await client.channels.cache.get(
                                cache[cmd.guild.id].users[
                                    cmd.customId.split("-")[1]
                                ].lastMessages[i].split("/")[0]
                            );
                            if (!channel || !("messages" in channel)) continue;

                            let badMess = await channel.messages.fetch(
                                cache[cmd.guild.id].users[
                                    cmd.customId.split("-")[1]
                                ].lastMessages[i].split("/")[1]
                            ).catch(() => null);
                            deleteMsgAndWarnings(badMess);
                            // badMess?.delete().catch(() => null);
                            cache[cmd.guild.id].users[cmd.customId.split("-")[1]].lastMessages.splice(i, 1);
                            i--;
                        }
                        catch (e) { console.log(e); }
                    }
                }
            }
            else {
                cmd.reply({
                    content: `You do not have sufficient permissions to kick members.`,
                    ephemeral: true
                });
            }
        }

        if (cmd.customId?.startsWith("del-")) {
            if (cmd.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                for (let i = 0; i < cache[cmd.guild.id].users[cmd.customId.split("-")[1]].lastMessages.length; i++) {
                    try {
                        let channel = await client.channels.cache.get(
                            cache[cmd.guild.id].users[
                                cmd.customId.split("-")[1]
                            ].lastMessages[i].split("/")[0]
                        );
                        if (!channel || !("messages" in channel)) continue;

                        let badMess = await channel.messages.fetch(
                            cache[cmd.guild.id].users[
                                cmd.customId.split("-")[1]
                            ].lastMessages[i].split("/")[1]
                        );
                        deleteMsgAndWarnings(badMess);
                        // badMess.delete().catch(() => null);
                        cache[cmd.guild.id].users[cmd.customId.split("-")[1]].lastMessages.splice(i, 1);
                        i--;
                    }
                    catch (e) { console.log(e); }
                }
                await cmd.reply({ content: `Done.`, ephemeral: true });
                cmd.message.delete().catch(() => { });
            }
            else {
                cmd.reply({ content: `You do not have sufficient permissions to delete messages.`, ephemeral: true });
            }
        }
    }
};
