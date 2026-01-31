using DTOM.Hubs;

namespace DTOM
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            // --- Configuração de Serviços ---
            builder.Services.AddControllersWithViews();
            builder.Services.AddSignalR();

            var app = builder.Build();

            // --- Configuração do Pipeline de Requisições (HTTP Pipeline) ---
            if (!app.Environment.IsDevelopment())
            {
                app.UseExceptionHandler("/Home/Error");
                app.UseHsts();
            }

            app.UseHttpsRedirection();

            // --- Middleware de Segurança: Content Security Policy (CSP) ---
            // Este middleware garante que recursos externos (YouTube, CDNs) 
            // sejam carregados sem violações de segurança.
            app.Use(async (context, next) =>
            {
                context.Response.OnStarting(() =>
                {
                    // Limpa cabeçalhos duplicados para evitar conflitos
                    context.Response.Headers.Remove("Content-Security-Policy");

                    context.Response.Headers["Content-Security-Policy"] =
                        "default-src 'self'; " +

                        // Scripts: Autoriza execução de scripts do YouTube, Google e CDNs
                        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://www.youtube.com https://www.gstatic.com; " +
                        "script-src-elem 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://www.youtube.com https://www.gstatic.com; " +

                        // Iframes: Necessário para a renderização do player do YouTube
                        "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; " +
                        "child-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; " +

                        // Conexões: Permite WebSocket (wss:) para o SignalR
                        "connect-src 'self' wss: https:; " +

                        // Estilos e Imagens: Design e thumbnails do YouTube
                        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
                        "img-src 'self' data: https: https://i.ytimg.com; " +

                        // Fontes: Ícones do Bootstrap via CDN
                        "font-src 'self' data: https: https://cdn.jsdelivr.net; " +

                        // Mídia: Fluxos de áudio e vídeo
                        "media-src 'self' https:;";

                    return Task.CompletedTask;
                });

                await next();
            });



            // --- Middlewares de Roteamento e Arquivos Estáticos ---
            app.UseStaticFiles();
            app.UseRouting();
            app.UseAuthorization();

            // --- Definição de Endpoints ---
            app.MapControllerRoute(
                name: "default",
                pattern: "{controller=Home}/{action=Index}/{id?}");

            // Mapeamento do Hub SignalR para comunicação em tempo real
            app.MapHub<DtomHub>("/dtomHub");

            app.Run();
        }
    }
}