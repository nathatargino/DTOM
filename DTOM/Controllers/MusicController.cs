using Microsoft.AspNetCore.Mvc;

namespace DTOM.Controllers
{
    [Route("api/[controller]")]
    public class MusicController : Controller
    {
        private readonly IHttpClientFactory _httpClientFactory;

        public MusicController(IHttpClientFactory httpClientFactory)
        {
            _httpClientFactory = httpClientFactory;
        }

        [HttpGet("proxy")]
        public async Task<IActionResult> Proxy(string url)
        {
            if (string.IsNullOrEmpty(url)) return BadRequest();

            var client = _httpClientFactory.CreateClient();
            // Adiciona headers para o YouTube não bloquear o download
            client.DefaultRequestHeaders.Add("User-Agent", "Mozilla/5.0");

            var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            var stream = await response.Content.ReadAsStreamAsync();

            return File(stream, "audio/mpeg", enableRangeProcessing: true);
        }
    }
}