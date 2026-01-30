using DTOM.Services;
using DTOM.Hubs;

namespace DTOM
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            // Add services to the container.
            builder.Services.AddControllersWithViews();

            // 1. Habilita o SignalR
            builder.Services.AddSignalR();

            // 2. Suporte ao HttpClient (Essencial para o Proxy de Áudio)
            builder.Services.AddHttpClient();

            // 3. Registro do serviço de música (Apenas uma vez)
            builder.Services.AddSingleton<MusicService>();

            var app = builder.Build();

            // Configure the HTTP request pipeline.
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

            // 4. Mapeia o Hub do SignalR
            app.MapHub<DtomHub>("/dtomHub");

            app.Run();
        }
    }
}