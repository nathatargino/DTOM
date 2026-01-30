using DTOM.Hubs;

namespace DTOM
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            builder.Services.AddControllersWithViews();
            builder.Services.AddSignalR();

            var app = builder.Build();

            if (!app.Environment.IsDevelopment())
            {
                app.UseExceptionHandler("/Home/Error");
                app.UseHsts();
            }

            app.UseHttpsRedirection();
            app.Use(async (context, next) =>
            {
                context.Response.OnStarting(() =>
                {
                    // Remove CSP antiga 
                    context.Response.Headers.Remove("Content-Security-Policy");

                    context.Response.Headers["Content-Security-Policy"] =
                        "default-src 'self'; " +

                        // Scripts (YouTube + jsdelivr)
                        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://www.youtube.com https://www.gstatic.com; " +
                        "script-src-elem 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://www.youtube.com https://www.gstatic.com; " +

                        // Iframes do YouTube
                        "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; " +
                        "child-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; " +

                        // Conexões (SignalR + https)
                        "connect-src 'self' wss: https:; " +

                        // Estilos / imagens
                        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
                        "img-src 'self' data: https: https://i.ytimg.com; " +

                        // Fontes (bootstrap-icons vem do jsdelivr)
                        "font-src 'self' data: https: https://cdn.jsdelivr.net; " +

                        // Mídia (opcional)
                        "media-src 'self' https:;";

                    return Task.CompletedTask;
                });

                await next();
            });


            app.UseStaticFiles();

            app.UseRouting();
            app.UseAuthorization();

            app.MapControllerRoute(
                name: "default",
                pattern: "{controller=Home}/{action=Index}/{id?}");

            app.MapHub<DtomHub>("/dtomHub");

            app.Run();
        }
    }
}
