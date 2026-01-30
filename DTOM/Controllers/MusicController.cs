using DTOM.Services;
using Microsoft.AspNetCore.Mvc;

namespace DTOM.Controllers
{
    [Route("api/[controller]")]
    public class MusicController : Controller
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly MusicService _musicService;

        public MusicController(IHttpClientFactory httpClientFactory, MusicService musicService)
        {
            _httpClientFactory = httpClientFactory;
            _musicService = musicService;
        }

        // 🔥 Em vez de receber URL assinada do googlevideo,
        // recebe o link do YouTube e resolve o stream em tempo real.
        [HttpGet("stream")]
        public async Task<IActionResult> Stream([FromQuery] string youtubeUrl)
        {
            if (string.IsNullOrWhiteSpace(youtubeUrl))
                return BadRequest("youtubeUrl is required");

            // Tenta 2 vezes: se der 403, re-extrai e tenta de novo
            for (int attempt = 1; attempt <= 2; attempt++)
            {
                var streamUrl = await _musicService.GetAudioStreamUrl(youtubeUrl);
                if (string.IsNullOrWhiteSpace(streamUrl))
                    return StatusCode(502, "Não foi possível obter o stream do YouTube.");

                var client = _httpClientFactory.CreateClient("yt");

                client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
                client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "*/*");
                client.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8");
                client.DefaultRequestHeaders.TryAddWithoutValidation("Referer", "https://www.youtube.com/");

                // ⭐ Range é importante para players/streams
                if (Request.Headers.TryGetValue("Range", out var range))
                    client.DefaultRequestHeaders.TryAddWithoutValidation("Range", range.ToString());

                using var resp = await client.GetAsync(streamUrl, HttpCompletionOption.ResponseHeadersRead);

                if (resp.IsSuccessStatusCode)
                {
                    var contentType = resp.Content.Headers.ContentType?.ToString() ?? "application/octet-stream";
                    var stream = await resp.Content.ReadAsStreamAsync();

                    // Repassa Content-Range quando existir (bom para seek)
                    if (resp.Content.Headers.TryGetValues("Content-Range", out var contentRange))
                        Response.Headers["Content-Range"] = contentRange.FirstOrDefault() ?? "";

                    return File(stream, contentType, enableRangeProcessing: true);
                }

                // Se 403 na 1ª tentativa, re-gerar streamUrl e tentar de novo
                if ((int)resp.StatusCode == 403 && attempt == 1)
                    continue;

                return StatusCode((int)resp.StatusCode, $"Upstream error: {(int)resp.StatusCode} {resp.ReasonPhrase}");
            }

            return StatusCode(500, "Falha inesperada ao obter stream.");
        }
    }
}
