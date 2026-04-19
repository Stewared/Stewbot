// #region CommandBoilerplate
const Categories = require("./modules/Categories");
const client = require("../client.js");
const { guildByObj } = require("./modules/database.js");
const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
function applyContext(context = {}) {
    for (let key in context) {
        this[key] = context[key];
    }
}

// #endregion CommandBoilerplate

const { getEmojiFromMessage, parseEmoji } = require("./emojiboard");

function getDefaultGroupmuteBoard() {
    return {
        active: false,
        threshold: 5,
        length: 60000 * 5,
        isMute: true,
        posters: new Map(),
        posted: new Map()
    };
}

/** @type {import("../command-module").CommandModule} */
module.exports = {
    data: {
        // Slash command data
        command: new SlashCommandBuilder().setName("groupmute_config")
            .setDescription("Configure the ability for server members to vote to mute someone")
            .addBooleanOption(option =>
                option.setName("active").setDescription("Is groupmute enabled?")
                    .setRequired(true)
            )
            .addStringOption(option =>
                option.setName("emoji").setDescription("The emoji to react with to trigger the mute")
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option.setName("threshold").setDescription("How many reactions are needed to trigger the mute? (Default: 5)")
                    .setMinValue(1)
            )
            .addIntegerOption(option =>
                option.setName("mute_length").setDescription("How long should they be muted for? (Default: 5 mins)")
                    .addChoices(
                        { name: "1 min", value: 60000 },
                        { name: "5 min", value: 60000 * 5 },
                        { name: "10 min", value: 600000 },
                        { name: "1 hour", value: 60000 * 60 },
                        { name: "1 day", value: 60000 * 60 * 24 }
                    )
            )
            .addBooleanOption(option =>
                option.setName("private").setDescription("Make the response ephemeral?")
                    .setRequired(false)
            )
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

        // Optional fields
        extra: { "contexts": [0], "integration_types": [0] },
        requiredGlobals: [],

        help: {
            helpCategories: [Categories.Administration, Categories.Configuration, Categories.Server_Only, Categories.Entertainment],
            shortDesc: "Configure the ability for server members to vote to mute someone", //Should be the same as the command setDescription field
            detailedDesc: //Detailed on exactly what the command does and how to use it
				`Configure an emoji that users can react to a message, and once it reaches a configured threshold the user will be timeouted for the configured amount of time.`
        }
    },

    async execute(cmd, context) {
        applyContext(context);
        const channelPerms = cmd.channel?.permissionsFor?.(client.user.id);
        if (!cmd.channel?.isSendable?.() || !channelPerms?.has(PermissionFlagsBits.ModerateMembers)) {
            cmd.followUp(`I can't help with groupmutes because I don't have the ModerateMembers permission.`);
            return;
        }

        var emoji = getEmojiFromMessage(cmd.options.getString("emoji"));
        if (!emoji) {
            cmd.followUp("That emoji is not valid.");
            return;
        }

        const guild = await guildByObj(cmd.guild);

        const oldEmoji = guild.groupmute;
        const existingTargetBoard = guild.emojiboards.get(emoji);

        // Keep regular emojiboards and groupmute data separate.
        if (existingTargetBoard && !existingTargetBoard.isMute && oldEmoji !== emoji) {
            cmd.followUp("That emoji is already in use for an emojiboard. Pick a different emoji or remove that emojiboard first.");
            return;
        }


        // If just moving to a different emoji
        if (oldEmoji && oldEmoji !== emoji) {
            const oldBoard = guild.emojiboards.get(oldEmoji);

            // If the old board is groupmute, carry it over to the new emoji.
            if (oldBoard?.isMute && !guild.emojiboards.has(emoji)) {
                guild.emojiboards.set(emoji, oldBoard);
            }

            // Only delete the old board if it was actually the mute board.
            if (oldBoard?.isMute) {
                guild.emojiboards.delete(oldEmoji);
            }
        }

        if (!guild.emojiboards.has(emoji)) {
            guild.emojiboards.set(emoji, getDefaultGroupmuteBoard());
        }

        const board = guild.emojiboards.get(emoji);

        // Repair older mixed records that may have lost mute flags.
        board.isMute = true;
        if (typeof board.threshold !== "number" || board.threshold < 1) board.threshold = 5;
        if (typeof board.length !== "number" || board.length < 1) board.length = 60000 * 5;
        if (!board.posters) board.posters = new Map();
        if (!board.posted) board.posted = new Map();

        board.active = cmd.options.getBoolean("active");
        guild.groupmute = emoji;

        if (cmd.options.getInteger("threshold") !== null)
            board.threshold = cmd.options.getInteger("threshold");

        if (cmd.options.getInteger("mute_length") !== null)
            board.length = cmd.options.getInteger("mute_length");

        await guild.save();

        cmd.followUp(
            `Alright, I have configured groupmute.${
                cmd.options.getBoolean("active")
                    ? ` If ${parseEmoji(emoji)} is reacted ${board.threshold} times, I'll mute the author of the message.`
                    : ``
            }`
        );
    }
};
