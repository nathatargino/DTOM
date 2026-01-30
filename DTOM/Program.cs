using DTOM.Services;
using DTOM.Hubs;
using System.Net;

namespace DTOM
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            builder.Services.AddControllersWithViews();
            builder.Services.AddSignalR();

            // ✅ HttpClient padrão 
            builder.Services.AddHttpClient();

            // ✅ HttpClient ESPECÍFICO
            builder.Services.AddHttpClient("yt")
                .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
                {
                    AutomaticDecompression = DecompressionMethods.None 
                });

            // MusicService
            builder.Services.AddSingleton<MusicService>();

            var app = builder.Build();

            if (!app.Environment.IsDevelopment())
            {
                app.UseExceptionHandler("/Home/Error");
                app.UseHsts();
            }

            app.UseHttpsRedirection();
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
