using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;

namespace DTOM.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class TurnController : ControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IConfiguration _configuration;

        public TurnController(IHttpClientFactory httpClientFactory, IConfiguration configuration)
        {
            _httpClientFactory = httpClientFactory;
            _configuration = configuration;
        }

        [HttpGet("credentials")]
        public async Task<IActionResult> GetTurnCredentials()
        {
            var turnKeyId = _configuration["Cloudflare:TurnKeyId"];
            var apiToken = _configuration["Cloudflare:ApiToken"];

            // 2. VALIDAÇÃO DE DADOS (Debug)
            // a) URL final será logada abaixo
            
            // b) Validação do ID
            if (string.IsNullOrEmpty(turnKeyId) || turnKeyId.Length != 32)
            {
                Console.WriteLine($"[TurnController] AVISO: TurnKeyId no user-secrets parece inválido (não tem 32 chars). Tamanho atual: {turnKeyId?.Length ?? 0}");
            }
            
            if (!string.IsNullOrEmpty(turnKeyId) && turnKeyId.Length >= 4)
            {
                Console.WriteLine($"[TurnController] TurnKeyId Prefix: {turnKeyId.Substring(0, 4)}");
            }

            if (string.IsNullOrEmpty(turnKeyId) || string.IsNullOrEmpty(apiToken))
            {
                Console.WriteLine("[TurnController] Credenciais ausentes.");
                return StatusCode(500, "As credenciais (TurnKeyId/ApiToken) não foram encontradas no User Secrets.");
            }

            // 3. REVISÃO DO ENDPOINT
            var url = $"https://rtc.live.cloudflare.com/v1/turn/keys/{turnKeyId}/credentials/generate";
            Console.WriteLine($"[TurnController] URL Gerada: {url}");

            var client = _httpClientFactory.CreateClient();

            var request = new HttpRequestMessage(HttpMethod.Post, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiToken);

            // 1. CORREÇÃO DE PROTOCOLO
            // Enviar corpo JSON com TTL de 24h (86400s)
            var jsonBody = "{\"ttl\": 86400}";
            request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");

            var response = await client.SendAsync(request);
            var jsonResponse = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                Console.WriteLine($"[TurnController] Erro Cloudflare: {response.StatusCode} - {jsonResponse}");
                return StatusCode((int)response.StatusCode, $"Erro Cloudflare: {jsonResponse}");
            }

            return Content(jsonResponse, "application/json");
        }
    }
}