////////
/// This file connects to the DB, registers global utility functions, etc
/// This file is heavily annotated for intellisense
////////
/// Notes:
///
/// - guildUserSchema:
///   This is the per-guild per-user object for user specific storage in-guild.
///   This is not stored under the guild directly because each document can only have 16MB
///   On top of that, it's just easier to store users on their own and index by the userID
///    because then it can auto-populate on fetch.
///
/// - ConfigDB:
///   This doc is the root-level storage. Anything global across stewbot,
///    like his pfp or RSS feeds to check daily, go here.
///
/// - Maps:
///   Maps in this case are the more efficient json.
///   The one issue with maps is that they can expand indefinitely.
///   Mongoose objects are only allowed to be 16MB in size currently.
///   This means at some point we should setup the DB to alert us when
///    starts getting close to this limit, so we can take whatever their
///    largest sub-schema is and move it to it's own doc like GuildUsers.


const { OAuth2Guild, Guild, User } = require("discord.js");
const { notify } = require("../../utils");
// const NodeCache = require('node-cache');
const { LRUCache } = require("lru-cache");
const ms = require("ms");
const mongoose = require("mongoose");
const { mongooseLeanVirtuals } = require("mongoose-lean-virtuals");
const mongooseLeanDefaults = require("mongoose-lean-defaults").default;
mongoose.plugin(mongooseLeanDefaults);
mongoose.plugin(mongooseLeanVirtuals);
mongoose.set("setDefaultsOnInsert", false);

// Message guild cache allows us to have less calls to the DB, and invalidate cache when we save DB changes
const messageDataCache = new LRUCache({ ttl: ms("5s"), max: 150 });

const config = require("../../data/config.json");


//#region Guild
let persistenceSchema = new mongoose.Schema({
    active: { type: Boolean, default: false },
    content: { type: String, default: "This is a Stewbot persistent message! Use /set_persistent_message to configure" },
    lastPost: { type: String, default: null }
});

let pollSchema = new mongoose.Schema({
    options: { type: Map, of: [String], default: {} }, // The key is the option, the string is the userID
    // options: {
    //     type: Object,
    //     default: {}
    // },
    title: String,
    legend: Boolean,
    labels: Boolean,
    chart: String
});

let levelsSchema = new mongoose.Schema({
    active: { type: Boolean, default: false },
    channel: { type: String, default: "" },
    location: { type: String, default: "DM" },
    msg: { type: String, default: "Congratulations ${USERNAME}, you have leveled up to level ${LVL}!" }
}, { _id: false });

let filterSchema = new mongoose.Schema({
    active: { type: Boolean, default: false },
    censor: { type: Boolean, default: true },
    log: { type: Boolean, default: false },
    channel: { type: String, default: "" },
    blacklist: [String] // TODO: rewrite this field into a filter item field, allowing regex and per-item stuff
});

let guildLogsSchema = new mongoose.Schema({
    active: { type: Boolean, default: false },
    channel: { type: String, default: "" },
    channel_events: { type: Boolean, default: false },
    emoji_events: { type: Boolean, default: false },
    user_change_events: { type: Boolean, default: false },
    joining_and_leaving: { type: Boolean, default: false },
    invite_events: { type: Boolean, default: false },
    role_events: { type: Boolean, default: false },
    mod_actions: { type: Boolean, default: false }
});

let dailyItemSchema = new mongoose.Schema({
    active: { type: Boolean, default: false },
    channel: { type: String, default: "" }
}, { _id: false });

let dailySchema = new mongoose.Schema({
    memes: { type: dailyItemSchema, default: {} },
    quotes: { type: dailyItemSchema, default: {} },
    facts: { type: dailyItemSchema, default: {} },
    devos: { type: dailyItemSchema, default: {} },
    verses: { type: dailyItemSchema, default: {} }
    // wyrs: { type: dailyItemSchema, default: {} },
    // jokes: { type: dailyItemSchema, default: {} },
});

let countingSchema = new mongoose.Schema({
    // Config
    active: { type: Boolean, default: false },
    channel: { type: String, default: "" },
    public: { type: Boolean, default: false },
    takeTurns: { type: Number, default: 1 },
    failRoleActive: { type: Boolean, default: false },
    warnRoleActive: { type: Boolean, default: false },
    failRole: { type: String, default: "" },
    warnRole: { type: String, default: "" },
    // State
    legit: { type: Boolean, default: true },
    reset: { type: Boolean, default: false },
    nextNum: { type: Number, default: 1 },
    highestNum: { type: Number, default: 0 },
    lastValidCountMessageId: { type: String, default: "" }
});

let autoLeaveMessageSchema = new mongoose.Schema({
    active: { type: Boolean, default: false },
    channel: { type: String, default: "" },
    message: { type: String, default: "Farewell ${@USER}. We'll miss you." }
}, { _id: false });

let tempBanSchema = new mongoose.Schema({
    invoker: String,
    ends: Number,
    reason: String,
    private: { type: Boolean, default: false }
});

let tempSlowmodeSchema = new mongoose.Schema({
    invoker: String,
    ends: Number,
    origMode: Number,
    guild: String,
    private: Boolean
});

let autoJoinMessageSchema = new mongoose.Schema({
    active: { type: Boolean, default: false },
    channel: { type: String, default: "" },
    dm: { type: Boolean, default: true },
    message: { type: String, default: "Greetings ${@USER}! Welcome to the server!" }
});

let emojiboardSchema = new mongoose.Schema({
    messType: String,
    threshold: Number,
    active: Boolean,
    channel: String,
    posted: { type: Map, of: String, default: {} }, // A record of the original message ID for us to delete
    posters: { type: Map, of: Number, default: {} }, // List of poster IDs mapped to how many posts they have
    isMute: { type: Boolean, default: false },
    length: { type: Number }, // Length of timeout from groupmute "emojiboard"
    ttl: { type: Number } // Age limit for crowdmute-eligible messages (0 disables)
});

let warningSchema = new mongoose.Schema({
    moderator: String,
    reason: String,
    severity: Number,
    when: Number
});

let guildConfigSchema = new mongoose.Schema({
    antihack_log_channel: { type: String, default: "" },
    antihack_to_log: { type: Boolean, default: false, required: false },
    antihack_auto_delete: { type: Boolean, default: true, required: false },
    domain_scanning: { type: Boolean, default: true },
    fake_link_check: { type: Boolean, default: true },
    format_exploit_check: { type: Boolean, default: true },
    timeReactions: { type: Boolean, default: true },
    ai: { type: Boolean, default: true },
    aiAccessMode: { type: String, enum: ["disabled", "whitelist", "blacklist"], default: "disabled" },
    aiAccessRoles: { type: [String], default: [] },
    embedPreviews: { type: Boolean, default: true },
    levelUpMsgs: { type: Boolean, default: false },
    keywords: { type: Boolean, default: false }
});

let guildSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
        match: [/^\d{5,}$/, "Error: ServerID must be digits only, and longer than 5 chars"]
    },
    guildTagRole: { type: String, default: "" },
    guildTagRoleActive: { type: Boolean, default: false },
    emojiboards: { type: Map, of: emojiboardSchema, default: {} },
    tempBans: { type: Map, of: tempBanSchema, default: {} },
    tempSlow: { type: Map, of: tempSlowmodeSchema, default: {} },
    polls: { type: Map, of: pollSchema, default: {} },
    persistence: { type: Map, of: persistenceSchema, default: {} },
    alm: { type: autoLeaveMessageSchema, default: {} },
    ajm: { type: autoJoinMessageSchema, default: {} },
    config: { type: guildConfigSchema, default: {} },
    levels: { type: levelsSchema, default: {} },
    daily: { type: dailySchema, default: {} },
    counting: { type: countingSchema, default: {} },
    logs: { type: guildLogsSchema, default: {} },
    filter: { type: filterSchema, default: {} },
    sentWelcome: { type: Boolean, default: false },
    autoJoinRoles: [String],
    blockedCommands: [String],
    pinners: String,
    groupmute: String, // The emoji tied to an emojiboard with groupmute configs
    disableAntiHack: Boolean,
    stickyRoles: Boolean
});
guildSchema.index({ id: 1, "logs.active": 1, "logs.user_change_events": 1 });
guildSchema.index({ tempBans: 1 });

let guildUserSchema = new mongoose.Schema({
    // See notes at the top
    userId: {
        type: String,
        required: true,
        index: true,
        trim: true,
        match: [/\d+/, "Error: ServerID must be digits only"]
    },
    guildId: {
        type: String,
        required: true,
        index: true,
        trim: true,
        match: [/\d+/, "Error: UserID must be digits only"]
    },
    tempRoles: { type: Map, of: Number, default: {} },
    infractions: { type: Number, defaults: 0 },
    safeTimestamp: { type: Number, default: 0, required: true },
    countTurns: { type: Number, default: 0 },
    beenCountWarned: { type: Boolean, default: false },
    lvl: { type: Number, default: 0 },
    exp: { type: Number, default: 0 },
    warnings: [warningSchema],
    roles: [String], // Roles stored on server leave, for sticky roles
    inServer: { type: Boolean, default: true } // This is used for logs and such - we retain guild user objects for sticky roles but want to know they're not in the server anymore.
});
guildUserSchema.index({ userId: 1, guildId: 1 }, { unique: true }); // Compound unique index - only one user per guild
guildUserSchema.index({ userId: 1, inServer: 1 }); // logs
guildUserSchema.index({ tempRoles: 1 }); // logs

//#endregion

//#region Users
let timerSchema = new mongoose.Schema({
    "time": Number,
    "respLocation": String,
    "reminder": String
});

let hatPullSchema = new mongoose.Schema({
    limit: { type: Number, default: 0 },
    winCount: { type: Number, default: 1 },
    entered: [String],
    closes: Number,
    location: String,
    registered: Boolean,
    user: String, // Opening user
    scheduled: { type: Boolean, default: false } // Set to false on boot, true when scheduled. Prevents double scheduling via boot and daily
});

let primedEmbedSchema = new mongoose.Schema({
    content: { type: String, default: "" },
    timestamp: { type: Number, required: true },

    author: {
        icon: { type: String, default: "" },
        name: { type: String, required: true },
        id: { type: String, required: true }
    },

    server: {
        channelName: { type: String, default: "" },
        name: { type: String, default: "" },
        channelId: { type: String, default: null },
        id: { type: String, default: "@me" },
        icon: { type: String, default: "" }
    },

    id: { type: String, required: true },

    attachmentURLs: {
        type: [String],
        default: []
    }
});

let userConfigSchema = new mongoose.Schema({
    trackableNotifsSilenced: { type: Boolean, default: false },
    beenAIDisclaimered: { type: Boolean, default: false },
    aiPings: { type: Boolean, default: true },
    timeReactions: { type: Boolean, default: true },
    noColon24h: { type: Boolean, default: false },
    dmOffenses: { type: Boolean, default: true },
    returnFiltered: { type: Boolean, default: true }, // infraction content
    embedPreviews: { type: Boolean, default: true },
    levelUpMsgs: { type: Boolean, default: true },
    hasSetTZ: { type: Boolean, default: false },
    timeOffset: { type: Number, default: 0 },
    timeOffsetMinutes: { type: Number, default: 0 },
    timeZoneRegion: { type: String, default: "" },
    observesDst: { type: Boolean, default: null },
    attachmentProtection: { type: Boolean, default: true }
});

let userSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
        match: [/\d+/, "Error: UserID must be digits only"]
    },
    primedEmbed: { type: primedEmbedSchema },
    primedEmojiURL: { type: String, default: "" },
    primedName: { type: String, default: "" },
    timedOutIn: [String],
    config: { type: userConfigSchema, default: {} },
    dmOffenses: { type: Boolean, default: true },
    hat_pull: hatPullSchema, // This one does not need defaults, it is checked for existence
    timer: timerSchema,
    captcha: Boolean,
    beenTimezoneInformed: { type: Boolean, default: false }
});

userSchema.index({ "hat_pull.location": 1 });
userSchema.index({ "timer": 1, "timer.time": 1 });
//#endregion

//#region Config
// Global bot config - everything from the top level "storage.json" goes here
let rssFeedSchema = new mongoose.Schema({
    hash: String,
    url: String,
    // channels: { type: Map, of: String, default: [] },
    channels: [String],
    lastSent: { type: Date, default: () => new Date() },
    fails: { type: Number, default: 0 }
});

const configSchema = new mongoose.Schema({
    useGlobalGemini: { type: Boolean, default: true },
    dailyMeme: { type: Number, default: 0 },
    pfp: String,
    rss: { type: Map, of: rssFeedSchema, default: {} },
    wotd: { type: String, default: "Jerry" },
    bootedAt: { type: Number, default: 0 },    // Last time the bot booted *without* /reboot (i.e. power outage)
    restartedAt: { type: Number, default: 0 }, // Last /reboot
    MOTD: {
        type: { // Statuses
            statuses: [],
            delay: { type: Number, default: 5000 }
        }, default: {}
    },
    blockedQuoteAuthors: { type: [String], default: [] }
});

const ConfigDB = mongoose.model("settings", configSchema);

//#endregion

//#region Functions

/**
 * Escapes special characters in MongoDB field names
 * @param {string} key - The key containing special characters
 * @return {string} - MongoDB-safe encoded key
 */
function keyEncode(key) {
    // return key;
    return key
        .replace(/\./g, "\\u002e")  // Escape dots
        .replace(/\$/g, "\\u0024"); // Escape dollar signs
}

/**
 * Decodes a MongoDB-escaped key back to its original form
 * @param {string} encodedKey - The MongoDB-safe encoded key
 * @return {string} - Original key with special characters restored
 */
function keyDecode(encodedKey) {
    // return encodedKey;
    return encodedKey
        .replace(/\\u002e/g, ".")   // Restore dots
        .replace(/\\u0024/g, "$");  // Restore dollar signs
}

/**
 * Returns a document matching the query or creates a new one, filling in unset default values.
 * Updates can be provided with the provided as a json map of key to new value.
 *
 * @param {Object} query - The query to find the document.
 * @param {Object} [updates={}] - The updates to apply to the document.
 * @returns {Promise<import("mongoose").HydratedDocument<import("mongoose").InferSchemaType<any>>>}
 * A mongoose document promise.
 */
function findOrCreate(query, updates = {}) {
    // Adding this as a static utility function to all docs.
    // This makes them create fields that don't already exist and such.
    return this.findOneAndUpdate(
        query,
        { $set: updates },
        {
            new: true,
            upsert: true,
            setDefaultsOnInsert: false
        }
    );
}
guildSchema.statics.findOrCreate = findOrCreate;
guildUserSchema.statics.findOrCreate = findOrCreate;
userSchema.statics.findOrCreate = findOrCreate;


async function guildByID(id, updates = {}) {
    // Fetch a guild from the DB, and create it if it does not already exist
    const guild = await Guilds.findOneAndUpdate(
        { id },
        { $set: updates },
        {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true,
            runValidators: true
        }
    );

    return guild;
}

/** @returns {Promise<GuildDoc>} */
async function guildByObj(obj, updates = {}) {
    if (!obj) return null;

    // Beta prechecks for dev mistakes
    if (
        process.env.beta && (
            !(obj instanceof Guild || obj instanceof OAuth2Guild)
        )
    ) {
        const warning = "WARNING: obj input seems incorrect. See console for stack trace.";
        console.trace(warning);
        notify(warning);
    }

    if (!obj) return null;

    const guild = await guildByID(obj.id, updates);
    return guild;
}

async function userByID(id, updates = {}, upsert = true) {
    // Fetch a user from the DB, apply updates, and create it if it does not already exist
    const user = await Users.findOneAndUpdate({ id }, updates, {
        new: true,
        upsert,
        setDefaultsOnInsert: false,
        runValidators: true
    });

    return user;
}

/** @returns {Promise<UserDoc>} */
async function userByObj(obj, updates = {}, upsert = true) {
    // Beta prechecks for dev mistakes
    if (
        process.env.beta && (
            !(obj instanceof User)
        )
    ) {
        const warning = "WARNING: obj input seems incorrect. See console for stack trace.";
        console.trace(warning);
        notify(warning);
    }

    const user = await userByID(obj.id, updates, upsert);

    return user;
}

async function guildUserByID(guildID, userID, updateData = {}, upsert) {
    // By default, this function, unlike the others, does not upsert new data.

    // Fetch and update in one query
    const user = await GuildUsers.findOneAndUpdate(
        { guildId: guildID, userId: userID },
        { $set: updateData },
        {
            new: true,
            setDefaultsOnInsert: false,
            upsert,
            runValidators: true
        }
    );

    return user;
}

/** @returns {Promise<GuildUserDoc>} */
async function guildUserByObj(guild, userID, updateData = {}) {
    // Beta prechecks for dev mistakes
    if (
        process.env.beta && (
            !(guild instanceof Guild) ||
            !(typeof (userID) == "string")
        )
    ) {
        const warning = "WARNING: obj input seems incorrect. See console for stack trace.";
        console.trace(warning);
        notify(warning);
    }

    // Ensure the user exists in the server first
    const serverUser = await guild.members.fetch(userID).catch(() => null);
    if (!serverUser) return null;

    // Fetch and update in one query
    // const user = await GuildUsers.findOneAndUpdate(
    //     { guildId: guild.id, userId: userID },
    //     { $set: updateData },
    //     { new: true, upsert: true, setDefaultsOnInsert: true }
    // );
    const user = await guildUserByID(guild.id, userID, updateData, true); // upsert is true since we've checked this user exists

    return user;
}
//#endregion

//#region Other
let trackableSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    owner: { type: String, required: true },   // ID of the creator of this trackable.
    creationDate: { type: Number, default: Date.now, required: true },
    current: { type: String, required: true }, // Current holder (user or channel). u/c prepends the ID.
    name: { type: String, required: true, default: "My New Trackable" },
    img: {
        type: String,
        required: true
    },
    desc: {
        type: String,
        required: true,
        default: `This is a trackable. [Install Stewbot](${config.install}), then run \`/trackable create\` to create your own! You can edit this message.`
    },
    tag: { type: String, required: true, default: "Look at my new trackable!!" },
    currentName: { type: String, required: true },
    placed: { type: Number, required: true, default: Date.now },
    layout: { type: Number, required: true, default: 0 }, // The type of layout
    color: { type: Number, required: true, default: 0x00d7ff },
    pastLocations: { type: [String], required: true, default: [] },
    status: { type: String, required: true, enum: ["editing", "published", "banned"], default: "editing" },

    expirationWarnedAboutAt: { type: Number, required: false }, // For expiration - this needs to be unset when moved around

    // Current location for linking
    currentGuildId: String,
    currentMessageId: String
});

let personalAiSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true }, // either UserID or GuildID.
    key: { type: String, required: true }, // API key

    // Options
    subsequentToolLimit: { type: Number }, // Subsequent tool calls limit
    llm_model: { type: String },
    toolBlacklist: { type: [String] }, // Tools to disable

    // Guild-only options
    ownerId: { type: String, required: true }, // Key owner if server key
    ratelimit: { type: Number }, // How many requests per ratelimit cycle
    ratelimitCycleLength: { type: Number } // How long a ratelimit cycle should last
});
//#endregion

// Cache invalidators
guildSchema.post("save", doc => { messageDataCache.delete(doc.id || ""); });
guildSchema.post("findOneAndUpdate", doc => { messageDataCache.delete(doc.id || ""); });
guildUserSchema.post("save", doc => { messageDataCache.delete(`${doc.guildId}>${doc.userId}`); });
guildUserSchema.post("findOneAndUpdate", doc => { messageDataCache.delete(`${doc.guildId}>${doc.userId}`); });


let quoteSchema = new mongoose.Schema({
    what: { type: String, required: true, unique: true }, // q
    who: { type: String, required: true }, // a
    blocked: { type: Boolean, required: true, default: false }
});

// const onThisDaySchema = new mongoose.Schema({

// });

// Set plugins and define docs
const Guilds = mongoose.model("guilds", guildSchema);
const GuildUsers = mongoose.model("guildusers", guildUserSchema);
const Users = mongoose.model("users", userSchema);
const Trackables = mongoose.model("trackables", trackableSchema);
const PersonalAIs = mongoose.model("personal_ais", personalAiSchema);
const Quotes = mongoose.model("quotes", quoteSchema);
// const OnThisDays = mongoose.model("on_this_days", onThisDaySchema);

// Drop indexes of docs where metadata was changed
async function dropIndexes(Model) {
    try {
        const indexes = await Model.collection.indexes();
        console.log("Indexes before deletion:", indexes.length);
        await Model.collection.dropIndexes();
        const indexes2 = await Model.collection.indexes();
        console.log("Indexes after deletion:", indexes2.length);
    }
    catch { }
}
function onConnect() {
    if (process.env.beta) {
        dropIndexes(GuildUsers);
        dropIndexes(Guilds);
        dropIndexes(Users);
    };

    mongoose.connection.db?.setProfilingLevel(
        process.env.beta
            ? "all"
            : "slow_only"
    );

    // Make sure ConfigDB is initialized
    ConfigDB.findOne().then(async (config) => {
        if (!config) {
            // If no config exists, create one
            const newConfig = new ConfigDB({});
            await newConfig.save();
        }
    });
}
mongoose.connection.on("connected", onConnect);


// These types need to be exported for a few places.
/**
 * @typedef {import("mongoose").InferSchemaType<typeof guildSchema>} RawGuildDoc
 * @typedef {import("mongoose").HydratedDocument<RawGuildDoc>} GuildDoc
 *
 * @typedef {import("mongoose").InferSchemaType<typeof userSchema>} RawUserDoc
 * @typedef {import("mongoose").HydratedDocument<RawUserDoc>} UserDoc
 *
 * @typedef {import("mongoose").InferSchemaType<typeof guildUserSchema>} RawGuildUserDoc
 * @typedef {import("mongoose").HydratedDocument<RawGuildUserDoc>} GuildUserDoc
 */

module.exports = {
    Guilds,
    guildByID,
    guildByObj,

    Users,
    userByID,
    userByObj,

    GuildUsers,
    guildUserByID, // This function is less preferred, as it does not check for guild member existence first
    guildUserByObj,

    ConfigDB,
    Trackables,
    PersonalAIs,
    Quotes,
    // OnThisDays,

    // Utilities
    keyDecode,
    keyEncode,
    messageDataCache
};
