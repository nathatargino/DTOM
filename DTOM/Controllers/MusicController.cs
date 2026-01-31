using DTOM.Services;
using Microsoft.AspNetCore.Mvc;
using System.Net;

namespace DTOM.Controllers
{
    /// <summary>
    /// Controller responsável pelo gerenciamento e streaming de mídia.
    /// </summary>
    [Route("api/[controller]")]
    public class MusicController : Controller
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly MusicService _musicService;

        /// <summary>
        /// Inicializa uma nova instância do <see cref="MusicController"/>.
        /// </summary>
        /// <param name="httpClientFactory">Factory para criação de clientes HTTP otimizados.</param>
        /// <param name="musicService">Serviço especializado em extração de metadados e streams do YouTube.</param>
        public MusicController(IHttpClientFactory httpClientFactory, MusicService musicService)
        {
            _httpClientFactory = httpClientFactory;
            _musicService = musicService;
        }

        /// <summary>
        /// Resolve uma URL do YouTube e realiza o proxy do stream de áudio em tempo real.
        /// Suporta processamento de Range para permitir busca (seek) no player.
        /// </summary>
        /// <param name="youtubeUrl">URL completa do vídeo do YouTube.</param>
        /// <returns>Stream de áudio binário para consumo imediato.</returns>
        [HttpGet("stream")]
        public async Task<IActionResult> Stream([FromQuery] string youtubeUrl)
        {
            if (string.IsNullOrWhiteSpace(youtubeUrl))
                return BadRequest("youtubeUrl is required");

            // Lógica de resiliência: Tenta até 2 vezes caso ocorra erro de autenticação (403)
            // indicando que a URL assinada do YouTube pode ter expirado.
            for (int attempt = 1; attempt <= 2; attempt++)
            {
                var streamUrl = await _musicService.GetAudioStreamUrl(youtubeUrl);

                if (string.IsNullOrWhiteSpace(streamUrl))
                    return StatusCode((int)HttpStatusCode.BadGateway, "Não foi possível obter o stream do YouTube.");

                var client = _httpClientFactory.CreateClient("yt");

                // Configuração de Headers técnicos para emular um navegador e evitar bloqueios
                client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
                client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "*/*");
                client.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8");
                client.DefaultRequestHeaders.TryAddWithoutValidation("Referer", "https://www.youtube.com/");

                // Repasse do Header de Range do cliente para o YouTube (Essencial para Seek/Buffering)
                if (Request.Headers.TryGetValue("Range", out var range))
                    client.DefaultRequestHeaders.TryAddWithoutValidation("Range", range.ToString());

                // Abre a conexão com o servidor de origem sem baixar o corpo imediatamente
                using var resp = await client.GetAsync(streamUrl, HttpCompletionOption.ResponseHeadersRead);

                if (resp.IsSuccessStatusCode)
                {
                    var contentType = resp.Content.Headers.ContentType?.ToString() ?? "application/octet-stream";
                    var stream = await resp.Content.ReadAsStreamAsync();

                    // Sincroniza metadados de Range para garantir que o player saiba o tamanho do buffer
                    if (resp.Content.Headers.TryGetValues("Content-Range", out var contentRange))
                        Response.Headers["Content-Range"] = contentRange.FirstOrDefault() ?? "";

                    return File(stream, contentType, enableRangeProcessing: true);
                }

                // Estratégia de Fallback: Se 403 (Forbidden), limpa cache e tenta re-extrair a URL
                if (resp.StatusCode == HttpStatusCode.Forbidden && attempt == 1)
                    continue;

                return StatusCode((int)resp.StatusCode, $"Upstream error: {(int)resp.StatusCode} {resp.ReasonPhrase}");
            }

            return StatusCode((int)HttpStatusCode.InternalServerError, "Falha inesperada ao obter stream.");
        }
    }
}