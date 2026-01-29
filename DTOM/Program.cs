namespace DTOM
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            // Add services to the container.
            builder.Services.AddControllersWithViews();

            // --- INSERÇÃO 1: Habilita o SignalR nos serviços ---
            builder.Services.AddSignalR();

            // Registro do serviço de música (Injeção de Dependência)
            builder.Services.AddSingleton<DTOM.Services.MusicService>();

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

            // --- INSERÇÃO 2: Mapeia o caminho (endpoint) do seu Hub ---
            // É através deste "/dtomHub" que o JavaScript vai se conectar
            app.MapHub<DTOM.Hubs.DtomHub>("/dtomHub");

            app.Run();
        }
    }
}