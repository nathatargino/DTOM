using DTOM.Services;
using Microsoft.AspNetCore.Mvc;

namespace DTOM.Controllers {
    [ApiController]
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

        // Recebe o link do YouTube e resolve o stream em tempo real.
        [HttpGet("stream")]
        public async Task < IActionResult > Stream([FromQuery] string youtubeUrl)
        {
            if (string.IsNullOrWhiteSpace(youtubeUrl))
                return BadRequest("youtubeUrl is required");

            for (int attempt = 1; attempt <= 2; attempt++)
            {
                string ? streamUrl = null;

                try {
                    streamUrl = await _musicService.GetAudioStreamUrl(youtubeUrl);
                    if (string.IsNullOrWhiteSpace(streamUrl))
                        return StatusCode(502, "Não foi possível obter o stream do YouTube.");

                    var client = _httpClientFactory.CreateClient("yt");

                    // Evita duplicar headers
                    client.DefaultRequestHeaders.Remove("User-Agent");
                    client.DefaultRequestHeaders.Remove("Accept");
                    client.DefaultRequestHeaders.Remove("Accept-Language");
                    client.DefaultRequestHeaders.Remove("Referer");
                    client.DefaultRequestHeaders.Remove("Origin");
                    client.DefaultRequestHeaders.Remove("Range");

                    client.DefaultRequestHeaders.TryAddWithoutValidation(
                        "User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
                    );
                    client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "*/*");
                    client.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8");
                    client.DefaultRequestHeaders.TryAddWithoutValidation("Referer", "https://www.youtube.com/");
                    client.DefaultRequestHeaders.TryAddWithoutValidation("Origin", "https://www.youtube.com");

                    // Range ajuda muito em áudio do YouTube
                    if (Request.Headers.TryGetValue("Range", out var range))
                        client.DefaultRequestHeaders.TryAddWithoutValidation("Range", range.ToString());

                    using var resp = await client.GetAsync(streamUrl, HttpCompletionOption.ResponseHeadersRead);

                    if (resp.IsSuccessStatusCode) {
                        var contentType = resp.Content.Headers.ContentType?.ToString()
                            ?? "application/octet-stream";

                        var stream = await resp.Content.ReadAsStreamAsync();

                        if (resp.Content.Headers.TryGetValues("Content-Range", out var contentRange))
                            Response.Headers["Content-Range"] = contentRange.FirstOrDefault() ?? "";

                        return File(stream, contentType, enableRangeProcessing: true);
                    }

                    // Retry só para 403 na primeira tentativa
                    if ((int)resp.StatusCode == 403 && attempt == 1)
                    continue;

                    // Retorna detalhe do upstream para debug
                    var body = await resp.Content.ReadAsStringAsync();
                    return StatusCode((int)resp.StatusCode, $"Upstream {(int)resp.StatusCode} {resp.ReasonPhrase}: {body}");
                }
                catch (Exception ex)
                {
                    // Se deu exception e é a primeira tentativa, tenta mais uma vez
                    if (attempt == 1) continue;

                    return StatusCode(500, $"Server error: {ex.Message}");
                }
            }

            return StatusCode(500, "Falha inesperada ao obter stream.");
        }
    }
}
