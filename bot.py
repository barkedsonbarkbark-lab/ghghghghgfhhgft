import asyncio
import os
from typing import Dict, List, Optional, Tuple

import discord
import yt_dlp
from discord.ext import commands
from py_youtube_search import YouTubeSearch

# ---- CONFIG ----
TOKEN = os.getenv("DISCORD_TOKEN")
FFMPEG_PATH = "ffmpeg/ffmpeg" if os.path.exists("ffmpeg/ffmpeg") else "ffmpeg"
# ----------------

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

queues: Dict[int, List[Tuple[str, str]]] = {}
now_playing: Dict[int, Optional[Tuple[str, str]]] = {}
loop_mode: Dict[int, bool] = {}
volume_levels: Dict[int, float] = {}

# Ensure FFmpeg is executable
if os.path.exists(FFMPEG_PATH):
    try:
        os.chmod(FFMPEG_PATH, os.stat(FFMPEG_PATH).st_mode | 0o111)
    except OSError:
        pass


async def search_youtube(query: str) -> Tuple[str, str]:
    yt = YouTubeSearch()
    results = await yt.search(query, limit=1)
    if not results:
        raise RuntimeError("No results found")

    video = results[0]
    video_id = video["id"]
    title = video["title"]
    return f"https://www.youtube.com/watch?v={video_id}", title


def _extract_audio_url_sync(youtube_url: str) -> str:
    ydl_opts = {
        # Let yt-dlp return full metadata first, then we pick an audio-capable format.
        # This avoids hard failing on videos where specific format selectors are missing.
        "cookiefile": "cookies.txt",
        "quiet": True,
        "noplaylist": True,
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(youtube_url, download=False)
        except yt_dlp.DownloadError as error:
            raise RuntimeError(f"yt-dlp failed for {youtube_url}: {error}") from error

    if not info:
        raise RuntimeError("No information found")

    formats = info.get("formats", [])

    # First try only audio streams
    for item in formats:
        if item.get("acodec") != "none" and item.get("vcodec") == "none":
            return item["url"]

    # Fallback: any stream with audio
    for item in formats:
        if item.get("acodec") != "none":
            return item["url"]

    raise RuntimeError("No playable audio formats found")


async def extract_audio_url(youtube_url: str) -> str:
    return await asyncio.to_thread(_extract_audio_url_sync, youtube_url)


async def play_next(guild_id: int) -> None:
    guild = bot.get_guild(guild_id)
    if guild is None:
        return

    voice = guild.voice_client
    if voice is None:
        return

    guild_queue = queues.get(guild_id, [])
    if len(guild_queue) == 0:
        await voice.disconnect()
        now_playing[guild_id] = None
        return

    if loop_mode.get(guild_id, False) and now_playing.get(guild_id):
        guild_queue.insert(0, now_playing[guild_id])

    url, title = guild_queue.pop(0)
    now_playing[guild_id] = (url, title)

    try:
        stream_url = await extract_audio_url(url)
    except Exception as error:
        print(f"Failed to extract playable stream for '{title}': {error}")
        now_playing[guild_id] = None
        # Attempt to continue with the next queued song instead of crashing the command.
        await play_next(guild_id)
        return
    source = discord.PCMVolumeTransformer(
        discord.FFmpegPCMAudio(
            stream_url,
            executable=FFMPEG_PATH,
            before_options="-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
            options="-vn",
        ),
        volume=volume_levels.get(guild_id, 0.5),
    )

    def after_play(error: Optional[Exception]) -> None:
        if error:
            print(f"Playback error: {error}")
        if bot.is_closed():
            return

        fut = asyncio.run_coroutine_threadsafe(play_next(guild_id), bot.loop)
        try:
            fut.result()
        except Exception as callback_error:
            print(f"Queue callback error: {callback_error}")

    voice.play(source, after=after_play)




@bot.tree.error
async def on_app_command_error(
    interaction: discord.Interaction, error: discord.app_commands.AppCommandError
) -> None:
    message = "Something went wrong while running that command."
    original = getattr(error, "original", None)
    if original:
        message = f"Command failed: {original}"

    try:
        if interaction.response.is_done():
            await interaction.followup.send(message)
        else:
            await interaction.response.send_message(message)
    except Exception:
        pass

@bot.event
async def on_ready() -> None:
    print(f"Logged in as {bot.user}")
    await bot.tree.sync()


@bot.tree.command(name="join", description="Join voice")
async def join(interaction: discord.Interaction) -> None:
    if interaction.user.voice is None:
        await interaction.response.send_message("Join a voice channel first.")
        return

    target_channel = interaction.user.voice.channel
    existing = interaction.guild.voice_client
    if existing:
        await existing.move_to(target_channel)
        await interaction.response.send_message("Moved to your voice channel.")
    else:
        await target_channel.connect()
        await interaction.response.send_message("Joined voice.")


@bot.tree.command(name="leave", description="Leave voice")
async def leave(interaction: discord.Interaction) -> None:
    vc = interaction.guild.voice_client
    if vc:
        await vc.disconnect()
        await interaction.response.send_message("Left voice.")
    else:
        await interaction.response.send_message("Not in voice.")


@bot.tree.command(name="play", description="Play music")
async def play(interaction: discord.Interaction, query: str) -> None:
    await interaction.response.send_message("Searching...")
    try:
        url, title = await search_youtube(query)
    except Exception as error:
        await interaction.followup.send(f"Search failed: {error}")
        return

    guild = interaction.guild
    gid = guild.id
    queues.setdefault(gid, []).append((url, title))

    if guild.voice_client is None:
        if interaction.user.voice is None:
            await interaction.followup.send("You must be in a voice channel!")
            return
        await interaction.user.voice.channel.connect()

    vc = guild.voice_client
    if vc and not vc.is_playing() and not vc.is_paused():
        await play_next(gid)

    await interaction.followup.send(f"Added: **{title}**")


@bot.tree.command(name="skip", description="Skip current")
async def skip(interaction: discord.Interaction) -> None:
    vc = interaction.guild.voice_client
    if vc and vc.is_playing():
        vc.stop()
        await interaction.response.send_message("Skipped.")
    else:
        await interaction.response.send_message("Nothing playing.")


@bot.tree.command(name="stop", description="Stop and clear queue")
async def stop(interaction: discord.Interaction) -> None:
    gid = interaction.guild.id
    queues[gid] = []
    now_playing[gid] = None

    vc = interaction.guild.voice_client
    if vc:
        vc.stop()
        await vc.disconnect()

    await interaction.response.send_message("Stopped & cleared.")


@bot.tree.command(name="queue", description="Show queue")
async def queue_cmd(interaction: discord.Interaction) -> None:
    gid = interaction.guild.id
    q = queues.get(gid, [])
    if not q:
        await interaction.response.send_message("Queue empty.")
        return

    msg = "\n".join(f"{i + 1}. {title}" for i, (_, title) in enumerate(q))
    await interaction.response.send_message(f"📋 Queue:\n{msg}")


@bot.tree.command(name="nowplaying", description="Show now playing")
async def nowplaying(interaction: discord.Interaction) -> None:
    info = now_playing.get(interaction.guild.id)
    if not info:
        await interaction.response.send_message("Nothing playing.")
    else:
        await interaction.response.send_message(f"🎶 Now playing: **{info[1]}**")


@bot.tree.command(name="volume", description="Set volume")
async def volume(interaction: discord.Interaction, level: int) -> None:
    clamped = max(0, min(level, 100))
    lvl = clamped / 100.0
    volume_levels[interaction.guild.id] = lvl

    vc = interaction.guild.voice_client
    if vc and vc.source:
        vc.source.volume = lvl

    await interaction.response.send_message(f"Volume: {clamped}%")


@bot.tree.command(name="loop", description="Toggle loop")
async def loop_cmd(interaction: discord.Interaction) -> None:
    gid = interaction.guild.id
    loop_mode[gid] = not loop_mode.get(gid, False)
    await interaction.response.send_message(f"Loop: **{loop_mode[gid]}**")


def main() -> None:
    if not TOKEN:
        raise RuntimeError("DISCORD_TOKEN environment variable is required")
    bot.run(TOKEN)


if __name__ == "__main__":
    main()
