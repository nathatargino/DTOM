using YoutubeExplode;
using YoutubeExplode.Videos.Streams;
using System.Net.Http;
using System.Net;

namespace DTOM.Services
{
    // TODO:
    public class MusicService
    {
        private readonly YoutubeClient _youtube;
        // ⚠️ Utilize o seu cookie real aqui ou via User Secrets
        private readonly string _cookie = "COLE_SEUS_COOKIES_AQUI";

        public MusicService()
        {
            // CookieContainer para gerenciar os cookies de forma mais "natural" para o .NET
            var cookieContainer = new CookieContainer();
            var handler = new HttpClientHandler
            {
                CookieContainer = cookieContainer,
                UseCookies = true,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
            };

            var httpClient = new HttpClient(handler);

            // Headers idênticos a um navegador moderno
            httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36");
            httpClient.DefaultRequestHeaders.Add("Accept", "*/*");
            httpClient.DefaultRequestHeaders.Add("Accept-Language", "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7");
            httpClient.DefaultRequestHeaders.Add("Origin", "https://www.youtube.com");
            httpClient.DefaultRequestHeaders.Add("Referer", "https://www.youtube.com/");

            // Adiciona o cookie no container se ele existir
            if (_cookie != "COLE_SEUS_COOKIES_AQUI" && !string.IsNullOrEmpty(_cookie))
            {
                // Tenta injetar via header manual caso o container falhe em domínios específicos
                httpClient.DefaultRequestHeaders.Add("Cookie", _cookie);
            }

            _youtube = new YoutubeClient(httpClient);
            Console.WriteLine("[MusicService] ✅ Inicializado com suporte avançado a Cipher e Cookies.");
        }

        public async Task<string?> GetAudioStreamUrl(string videoUrl)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(videoUrl)) return null;

                // Força a extração do VideoId para evitar lixo de URL (playlists, trackers)
                var videoId = YoutubeExplode.Videos.VideoId.TryParse(videoUrl);
                if (videoId == null)
                {
                    Console.WriteLine("[MusicService] ⚠️ URL Inválida.");
                    return null;
                }

                string targetId = videoId.Value;
                Console.WriteLine($"[MusicService] 🛡️ Extraindo áudio para o ID: {targetId}");

                // Obtém o manifest usando o ID limpo
                var streamManifest = await _youtube.Videos.Streams.GetManifestAsync(targetId);

                // Prioridade: AudioOnly com maior Bitrate
                var streamInfo = streamManifest.GetAudioOnlyStreams().GetWithHighestBitrate();

                // Fallback: Muxed Streams (Vídeo + Áudio juntos)
                if (streamInfo == null)
                {
                    streamInfo = streamManifest.GetMuxedStreams()
                        .OrderByDescending(s => s.Bitrate)
                        .FirstOrDefault();
                }

                if (streamInfo != null)
                {
                    Console.WriteLine($"[MusicService] ✅ Stream encontrado! Bitrate: {streamInfo.Bitrate}");
                    return streamInfo.Url;
                }

                return null;
            }
            catch (Exception ex)
            {
                // Log detalhado para capturar falhas de descriptografia (Cipher)
                Console.WriteLine($"[MusicService] ❌ Falha na extração (Cipher/403): {ex.Message}");

                if (ex.Message.Contains("cipher"))
                {
                    throw new Exception("O YouTube mudou a criptografia deste vídeo. Tente um link de Lo-fi ou vídeo comum.");
                }

                throw new Exception($"Erro técnico: {ex.Message}");
            }
        }
    }
}