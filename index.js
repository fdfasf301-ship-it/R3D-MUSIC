require("dotenv").config({ quiet: true });

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  getVoiceConnection,
} = require("@discordjs/voice");

const youtubedl = require("youtube-dl-exec");
const ffmpeg = require("ffmpeg-static");
const { spawn } = require("child_process");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    const queue = {
      songs: [],
      player,
      connection: null,
      playing: false,
      paused: false,
      textChannel: null,
      ffmpegProcess: null,
      currentSong: null,
      dashboardMessage: null,
    };

    player.on(AudioPlayerStatus.Idle, () => {
      playNext(guildId);
    });

    player.on("error", (err) => {
      console.error("Player error:", err);
    });

    queues.set(guildId, queue);
  }

  return queues.get(guildId);
}

async function getSong(query) {
  const cleanQuery = query.trim().replace(/\s+/g, "+");

  const searchQuery = query.startsWith("http")
    ? query
    : `ytsearch1:${cleanQuery}+lyrics`;

  const info = await youtubedl(searchQuery, {
    dumpSingleJson: true,
    defaultSearch: "ytsearch",
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    preferFreeFormats: true,
    addHeader: [
      "referer:youtube.com",
      "user-agent:Mozilla/5.0",
    ],
  });

  const video = info.entries ? info.entries[0] : info;

  if (!video) return null;

  const videoUrl =
    video.webpage_url ||
    video.original_url ||
    video.url ||
    `https://www.youtube.com/watch?v=${video.id}`;

  const audioInfo = await youtubedl(videoUrl, {
    dumpSingleJson: true,
    format: "bestaudio[ext=m4a]/bestaudio/best",
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
  });

  return {
    title: audioInfo.title || video.title || "Unknown",
    url: audioInfo.url,
    webpage: videoUrl,
  };
}

function createFFmpegStream(url) {
  return spawn(
    ffmpeg,
    [
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-i",
      url,
      "-analyzeduration",
      "0",
      "-loglevel",
      "0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    { windowsHide: true }
  );
}

function createDashboard(song, user) {
  const embed = new EmbedBuilder()
    .setColor("#2b2d31")
    .setTitle("playing")
    .setDescription(`[${song.title}](${song.webpage || song.url})`)
    .setFooter({
      text: user.username,
      iconURL: user.displayAvatarURL(),
    });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_resume")
      .setLabel("▷")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_restart")
      .setLabel("|◀")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_pause")
      .setLabel("Ⅱ")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_skip")
      .setLabel("▶|")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_loop")
      .setLabel("↪")
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_vol_down")
      .setLabel("◀")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_back")
      .setLabel("◀◀")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_fav")
      .setLabel("♡")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_forward")
      .setLabel("▶▶")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_vol_up")
      .setLabel("▶")
      .setStyle(ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_mic")
      .setLabel("♩")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_shuffle")
      .setLabel("⌘")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_stop")
      .setLabel("×")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_filter")
      .setLabel("▾")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_extra")
      .setLabel("♙")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row1, row2, row3],
  };
}

async function playSong(guildId, song) {
  const queue = queues.get(guildId);
  if (!queue) return;

  queue.playing = true;
  queue.paused = false;
  queue.currentSong = song;

  if (queue.ffmpegProcess) {
    queue.ffmpegProcess.kill();
  }

  const ffmpegProcess = createFFmpegStream(song.url);

  queue.ffmpegProcess = ffmpegProcess;

  const resource = createAudioResource(
    ffmpegProcess.stdout,
    {
      inputType: StreamType.Raw,
    }
  );

  queue.player.play(resource);

  const dashboard = createDashboard(song, client.user);

  if (queue.dashboardMessage) {
    try {
      await queue.dashboardMessage.edit(dashboard);
    } catch {
      queue.dashboardMessage =
        await queue.textChannel.send(dashboard);
    }
  } else {
    queue.dashboardMessage =
      await queue.textChannel.send(dashboard);
  }
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  const song = queue.songs.shift();

  if (!song) {
    queue.playing = false;
    queue.currentSong = null;
    return;
  }

  try {
    await playSong(guildId, song);
  } catch (err) {
    console.error("Play error:", err);

    queue.playing = false;
    queue.currentSong = null;
  }
}

client.once("clientReady", () => {
  console.log(`${client.user.tag} is online ✅`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  if (!message.content.startsWith("ش")) return;

  const args = message.content.trim().split(/ +/);

  const cmd = args.shift()?.toLowerCase();

  if (cmd === "ش") {
    const query = args.join(" ");

    if (!query) {
      return message.reply(
        "اكتب اسم الأغنية أو لينك يوتيوب."
      );
    }

    const voiceChannel =
      message.member.voice.channel;

    if (!voiceChannel) {
      return message.reply(
        "ادخل روم صوت الأول."
      );
    }

    const queue = getQueue(message.guild.id);

    queue.textChannel = message.channel;

    try {
      const song = await getSong(query);

      if (!song || !song.url) {
        return message.reply(
          "❌ ملقتش لينك صوت."
        );
      }

      if (!queue.connection) {
        queue.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: message.guild.id,
          adapterCreator:
            message.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });

        queue.connection.subscribe(queue.player);
      }

      queue.songs.push(song);

      if (!queue.playing) {
        playNext(message.guild.id);
      } else {
        message.reply(
          `✅ اتضافت للكيو: **${song.title}**`
        );
      }
    } catch (err) {
      console.error(err);

      message.reply(
        "❌ حصل خطأ في تشغيل الأغنية."
      );
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const queue = queues.get(interaction.guild.id);

  if (!queue) {
    return interaction.reply({
      content: "مفيش حاجة شغالة.",
      ephemeral: true,
    });
  }

  if (interaction.customId === "music_pause") {
    queue.player.pause();
    queue.paused = true;
    return interaction.deferUpdate();
  }

  if (interaction.customId === "music_resume") {
    queue.player.unpause();
    queue.paused = false;
    return interaction.deferUpdate();
  }

  if (interaction.customId === "music_skip") {
    if (queue.ffmpegProcess) {
      queue.ffmpegProcess.kill();
    }

    queue.player.stop();

    return interaction.deferUpdate();
  }

  if (interaction.customId === "music_stop") {
    if (queue.ffmpegProcess) {
      queue.ffmpegProcess.kill();
    }

    const connection = getVoiceConnection(
      interaction.guild.id
    );

    if (connection) {
      connection.destroy();
    }

    queues.delete(interaction.guild.id);

    return interaction.deferUpdate();
  }

  if (interaction.customId === "music_restart") {
    if (!queue.currentSong) {
      return interaction.deferUpdate();
    }

    await playSong(
      interaction.guild.id,
      queue.currentSong
    );

    return interaction.deferUpdate();
  }

  if (interaction.customId === "music_loop") {
    if (queue.currentSong) {
      queue.songs.unshift(queue.currentSong);
    }

    return interaction.deferUpdate();
  }

  if (interaction.customId === "music_back") {
    return interaction.reply({
      content:
        "⏮️ الرجوع للأغنية السابقة مش متفعل حاليًا.",
      ephemeral: true,
    });
  }

  if (
    [
      "music_vol_down",
      "music_vol_up",
      "music_fav",
      "music_forward",
      "music_mic",
      "music_shuffle",
      "music_filter",
      "music_extra",
    ].includes(interaction.customId)
  ) {
    return interaction.deferUpdate();
  }
});

client.login(process.env.TOKEN);