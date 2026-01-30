using YoutubeExplode;
using YoutubeExplode.Videos;
using YoutubeExplode.Videos.Streams;
using Microsoft.Extensions.Configuration;
using System.Net;
using System.Net.Http;

namespace DTOM.Services
{
    public class MusicService
    {
        private readonly YoutubeClient _youtube;
        private readonly string _cookie;

        public MusicService(IConfiguration config)
        {
            // Ajustado Conforme secret:
            
            _cookie = config["YouTube:Cookie"] ?? config["YoutubeCookie"] ?? "";

            var cookieContainer = new CookieContainer();
            var handler = new HttpClientHandler
            {
                CookieContainer = cookieContainer,
                UseCookies = true,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
            };

            var httpClient = new HttpClient(handler);
            httpClient.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
            httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8");
            httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "*/*");

            if (!string.IsNullOrWhiteSpace(_cookie))
                httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Cookie", _cookie);

            _youtube = new YoutubeClient(httpClient);
        }

        public async Task<string?> GetAudioStreamUrl(string videoUrl)
        {
            if (string.IsNullOrWhiteSpace(videoUrl)) return null;

            var videoId = VideoId.TryParse(videoUrl);
            if (videoId is null) return null;

            // Detecta live (Duration null geralmente indica live no YoutubeExplode)
            var video = await _youtube.Videos.GetAsync(videoId.Value);
            if (video.Duration is null)
                throw new Exception("Este link é uma LIVE. No momento só suportamos vídeos comuns (não-live).");

            var manifest = await _youtube.Videos.Streams.GetManifestAsync(videoId.Value);

            // AudioOnly preferindo MP4
            var audioOnly = manifest.GetAudioOnlyStreams();

            var streamInfo = audioOnly
                .Where(s => s.Container == Container.Mp4)
                .GetWithHighestBitrate()
                ?? audioOnly.GetWithHighestBitrate();

            // Se não existir audio-only, tenta muxed MP4 
            streamInfo ??= manifest.GetMuxedStreams()
                .Where(s => s.Container == Container.Mp4)
                .OrderByDescending(s => s.Bitrate)
                .FirstOrDefault();

            return streamInfo?.Url;
        }
    }
}
