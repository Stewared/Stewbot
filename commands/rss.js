// #region CommandBoilerplate
const Categories = require("./modules/Categories");
const client = require("../client.js");
const { ConfigDB } = require("./modules/database.js");
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, Events } = require("discord.js");
function applyContext(context = {}) {
    for (let key in context) {
        this[key] = context[key];
    }
}

// #endregion CommandBoilerplate

const crypto = require("crypto");
const Turndown = require("turndown");
const dns = require("dns");
const { URL } = require("url");
const { limitLength } = require("../utils.js");
const { notify } = require("../utils");

const RSSParser = require("rss-parser");
var turndown = new Turndown();
const cheerio = require("cheerio");
const RSS_CHECK_INTERVAL_MS = 60000 * 10;
let rssCheckInProgress = false;
let rssPollingStarted = false;

// Setup RSS parser
const rssParser = new RSSParser({
    customFields: {
        item: ["description"]
    }
});

// Setup turndown parser
turndown.addRule("ignoreAll", {
    filter: ["img"], // Ignore image tags in description
    replacement: function() {
        return "";
    }
});


// Utility functions for RSS security
function isPrivateIP(ip) {
    const privateRanges = [
        /^127\./,      // Loopback
        /^10\./,       // Private
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private
        /^192\.168\./, // Private
        /^169\.254\./  // Link-local
    ];
    return privateRanges.some((range) => range.test(ip));
};
async function isUrlAllowed(inputUrl) {
    try {
        let url;
        try {
            url = new URL(inputUrl);
        }
        catch {
            return [false, "that is not a valid url."];
        }

        // Only allow http/https protocols
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return [false, "only http and https are allowed."];
        }

        const addresses = await new Promise((resolve, reject) => {
            dns.lookup(url.hostname, { all: true }, (err, addresses) => {
                if (err) return reject(err);
                resolve(addresses);
            });
        });

        for (const { address } of addresses) {
            if (isPrivateIP(address)) {
                return [false, "private IPs are not allowed"];
            }
        }

        // URL is safe
        return [true, "valid"];

    }
    catch {
        return [false, "URL validation failed - general failure"];
    }
}
const validateDNSForPrivateIP = async (hostname) => {
    return new Promise((resolve, reject) => {
        dns.lookup(hostname, { all: true }, (err, addresses) => {
            if (err) return reject(err);
            for (const { address } of addresses) {
                if (isPrivateIP(address)) {
                    return reject(new Error("Redirected to restricted IP address"));
                }
            }
            resolve();
        });
    });
};
const fetchWithRedirectCheck = async (inputUrl, maxRedirects = 5) => {
    let url = new URL(inputUrl);
    let redirects = 0;

    while (redirects < maxRedirects) {
        const response = await fetch(url.href, { redirect: "manual" });
        if (response.status < 300 || response.status >= 400) {
            return response;
        }
        const location = response.headers.get("location");
        if (!location) {
            throw new Error("Redirect response without Location header");
        }
        // Resolve the new URL relative to the original
        url = new URL(location, url);

        // Perform DNS validation to prevent redirecting to private IPs
        await validateDNSForPrivateIP(url.hostname);
        redirects += 1;
    }

    throw new Error("Too many redirects");
};
async function checkRSS() {
    if (rssCheckInProgress) {
        return;
    }

    rssCheckInProgress = true;

    try {
        const config = await ConfigDB.findOne({});
        if (!config) {
            return;
        }

        for (const feedHash of config.rss.keys()) {

            const feed = config.rss.get(feedHash);

            if (feed.channels.length === 0) {
                config.rss.delete(feedHash);
            }
            else {
                var cont = true;
                var parsed;
                try {
                    // Get the URL myself to prevent local IP redirects
                    const data = await (await fetchWithRedirectCheck(feed.url)).text();
                    parsed = await rssParser.parseString(data);
                    feed.fails = 0;
                }
                catch {
                    cont = false;

                    // Track fails
                    feed.fails++;

                    // Remove failing URLs
                    if (feed.fails > 7) {
                        config.rss.delete(feedHash);
                    }
                }
                if (cont) {
                    let lastSentDate = new Date(feed.lastSent);
                    let mostRecentArticle = lastSentDate;

                    for (let item of parsed.items.reverse()) {
                        let thisArticleDate = new Date(item.isoDate);
                        if (lastSentDate < thisArticleDate) {
                            // Keep track of most recent
                            if (mostRecentArticle < thisArticleDate) {
                                mostRecentArticle = thisArticleDate;
                            }

                            // Parse before sending to each channel
                            try {
                                // Extract theoretically required fields per https://www.rssboard.org/rss-specification
                                const link = item.link || parsed.link; // default to channel URL
                                let baseUrl = "";
                                if (link) { // Attempt to get baseURL for turndown parsing
                                    try {
                                        baseUrl = new URL(link).origin;
                                    }
                                    catch {
                                        baseUrl = ""; // fallback if URL is invalid
                                    }
                                }

                                let parsedDescription = turndown.turndown(item.description?.replace?.(/href="\/(.*?)"/g, `href="${(baseUrl)}/$1"`) || "");
                                let content =  parsedDescription || item.contentSnippet || turndown.turndown(item.content || "") || "No Summary Available";
                                content = content.replace(/&quot;/g, '"')
                                    .replace(/&amp;/g, "&")
                                    .replace(/&lt;/g, "<")
                                    .replace(/&gt;/g, ">");

                                const embed = new EmbedBuilder()
                                    .setColor(0x5faa66)
                                    .setTitle(limitLength(item.title || parsed.description || "No Title", 256)) // If no title, grab the feed description
                                    .setDescription(limitLength(content, 1000));
                                if (link) embed.setURL(link);

                                // Optional fields
                                const creator = item.creator || item["dc:creator"] || parsed.title || "Unknown Creator"; //
                                // @ts-ignore - optional chaining
                                const imageUrl = item?.image?.url || parsed?.image?.url;
                                if (creator) embed.setAuthor({ name: creator });
                                if (imageUrl) embed.setThumbnail(imageUrl);

                                // If the description has an image, attempt to load it as a large image (image *fields* are usually thumbnails / logos)
                                const $ = cheerio.load(item.description || "");
                                const contentImage = $("img").attr("src");
                                if (contentImage) embed.setImage(contentImage);

                                // Send this feed to everyone following it
                                for (let channelId of feed.channels) {
                                    let channel = client.channels.cache.get(channelId);
                                    if (channel === undefined || channel === null || !channel.isSendable()) {
                                        feed.channels.splice(feed.channels.indexOf(channelId), 1);
                                    }
                                    else {
                                        try {
                                            channel.send({
                                                content: `-# New notification from [a followed RSS feed](${item.link})`,
                                                embeds: [embed]
                                            });
                                        }
                                        catch (e) {
                                            notify("RSS channel error: " + e.message + "\n" + e.stack);
                                        }
                                    }
                                }
                            }
                            catch (e) {
                                notify("RSS feed error: " + e.message + "\n" + e.stack);
                            }
                        }
                    };
                    // Update feed most recent now after sending all new ones since last time
                    feed.lastSent = mostRecentArticle;
                }
            }
        };

        await config.save();
    }
    catch (e) {
        notify("RSS scheduler error: " + e.message + "\n" + e.stack);
    }
    finally {
        rssCheckInProgress = false;
    }
}

function startRSSPolling() {
    if (rssPollingStarted) {
        return;
    }

    rssPollingStarted = true;
    void checkRSS();
    setInterval(() => {
        void checkRSS();
    }, RSS_CHECK_INTERVAL_MS);
}

if (client.isReady()) {
    startRSSPolling();
}
else {
    client.once(Events.ClientReady, () => {
        startRSSPolling();
    });
}

/** @type {import("../command-module").CommandModule} */
module.exports = {
    data: {
        // Slash command data
        command: new SlashCommandBuilder().setName("rss")
            .setDescription("Commands relating to RSS feeds")
            .addSubcommand(command =>
                command.setName("follow").setDescription("Follow an RSS feed")
                    .addChannelOption(option =>
                        option.setName("channel").setDescription("The channel to follow this RSS feed in")
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildText)
                    )
                    .addStringOption(option =>
                        option.setName("feed").setDescription("The feed to follow")
                            .setRequired(true)
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(command =>
                command.setName("unfollow").setDescription("Unfollow an RSS feed")
                    .addChannelOption(option =>
                        option.setName("channel").setDescription("The channel to unfollow this RSS feed from")
                            .setRequired(true)
                    )
                    .addStringOption(option =>
                        option.setName("feed").setDescription("The feed to unfollow (Type 'all' to unfollow all)")
                            .setRequired(true)
                    )
                    .addBooleanOption(option =>
                        option.setName("private").setDescription("Make the response ephemeral?")
                            .setRequired(false)
                    )
            )
            .addSubcommand(command =>
                command.setName("check").setDescription("Check the RSS feeds a channel follows")
                    .addChannelOption(option =>
                        option.setName("channel").setDescription("The channel to check RSS feeds for")
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildText)
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
            follow: {
                helpCategories: [Categories.Information, Categories.Configuration, Categories.Administration, Categories.Server_Only],
                shortDesc: "Follow an RSS feed", //Should be the same as the command setDescription field
                detailedDesc: //Detailed on exactly what the command does and how to use it
					`Specify a channel and an RSS feed, and Stewbot will check that feed every 10 minutes and post any new updates into the channel.`
            },
            unfollow: {
                helpCategories: [Categories.Configuration, Categories.Administration, Categories.Server_Only],
                shortDesc: "Unfollow an RSS feed", //Should be the same as the command setDescription field
                detailedDesc: //Detailed on exactly what the command does and how to use it
					`Specify the channel the feed is followed in, and the URL of the feed to unfollow, and Stewbot will no longer post RSS updates for that feed there. You can use ${cmds.rss.check.mention} to get the URL needed for this command.`
            },
            check: {
                helpCategories: [Categories.Information, Categories.Administration, Categories.Server_Only],
                shortDesc: "Check the RSS feeds a channel follows", //Should be the same as the command setDescription field
                detailedDesc: //Detailed on exactly what the command does and how to use it
					`Run this command to check which RSS URLs Stewbot is posting from in the specified channel.`
            }
        }
    },

    async execute(cmd, context) {
        applyContext(context);

        const channelInput = cmd.options.getChannel("channel");

        let config;

        switch (cmd.options.getSubcommand()) {
            case "check": {
                const followedURLs = await ConfigDB.aggregate([
                    // Create a document with an array of all rss items
                    { $project: {
                        rssArray: {
                            $objectToArray: "$rss"
                        }
                    } },
                    // Split the each item of the rrs array into separate documents
                    { $unwind: "$rssArray" },
                    // Match only rss item documents that this channel follows
                    { $match: {
                        "rssArray.v.channels": channelInput.id
                    } },
                    // Extract just the URL of each document
                    { $project: {
                        url: "$rssArray.v.url",
                        _id: 0
                    } }
                ]);

                await cmd.followUp(
                    followedURLs.length > 0
                        ? `The RSS feeds being followed for <#${channelInput.id}> include the following:\n${
                            followedURLs.map(f => `- ${f.url}`).join("\n")
                        }`
                        : `There are no feeds followed in <#${channelInput.id}>`
                );
                break;
            }

            case "follow": {
                if (!("isSendable" in channelInput) || !channelInput.isSendable()) {
                    await cmd.followUp(`I'm not allowed to send messages in <#${channelInput.id}> so this action cannot be completed.`);
                    break;
                }

                // Validate URL
                const url = cmd.options.getString("feed").trim();

                // Validate URL form
                const [urlAllowed, errorText] = await isUrlAllowed(url);
                if (!urlAllowed) {
                    await cmd.followUp(`This URL is not allowed: ${errorText}`);
                    break;
                }

                // Make sure it is a valid link
                try {
                    await fetchWithRedirectCheck(url);
                }
                catch (error) {
                    await cmd.followUp(`URL validation failed: ${error.message}`);
                    break;
                }

                // Final make sure it is valid RSS
                try {
                    await rssParser.parseURL(url);
                }
                catch {
                    await cmd.followUp(`Error parsing RSS from link.`);
                    break;
                }
                // At this point, the URL is valid and all

                // TODO: trim URL, make sure it's in standard notation for the hash
                var hash = crypto.createHash("md5").update(url)
                    .digest("hex");
                config = await ConfigDB.findOne({});

                // Create a new container for this hash
                if (!config.rss.has(hash)) {
                    config.rss.set(hash, {
                        "hash": hash,
                        "url": url,
                        "channels": [],
                        "lastSent": new Date(),
                        "fails": 0
                    });
                }

                if (config.rss.get(hash).channels.includes(channelInput.id)) {
                    await cmd.followUp("You already follow that feed in that channel");
                    return;
                }

                config.rss.get(hash).channels.push(channelInput.id);
                await config.save();
                await cmd.followUp("I have followed the feed for that channel");
                break;
            }

            case "unfollow": {
                config = await ConfigDB.findOne({});
                if (cmd.options.getString("feed").toLowerCase() !== "all") {
                    let hash = crypto.createHash("md5").update(cmd.options.getString("feed").trim())
                        .digest("hex");
                    if (config.rss.get(hash)?.channels.includes(channelInput.id)) {
                        config.rss.get(hash).channels.splice(config.rss.get(hash).channels.indexOf(channelInput.id), 1);
                        await cmd.followUp("I have unfollowed the feed for that channel");
                    }
                    else {
                        await cmd.followUp(`You don't seem to follow that feed in that channel`);
                    }
                    await config.save();
                }
                else {
                    // Remove this channel from all feeds
                    const updates = {};
                    for (const key of config.rss.keys()) {
                        updates[`rss.${key}.channels`] = channelInput.id;
                    }
                    await config.updateOne({ $pull: updates }); // Remove these channels

                    await cmd.followUp(`I have unfollowed all feeds for that channel`);
                }
                break;
            }
        }
    },

    async daily(context) {
        applyContext(context);

        void checkRSS();
    }
};
