# 🎧 DTOM.net - Chamadas de Voz em Tempo real com músicas.

<div align="center">

![Status](https://img.shields.io/badge/Status-Active-success?style=for-the-badge)
![.NET](https://img.shields.io/badge/.NET-8.0-512BD4?style=for-the-badge&logo=dotnet&logoColor=white)
![SignalR](https://img.shields.io/badge/SignalR-RealTime-1ecdff?style=for-the-badge)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P_Audio-333333?style=for-the-badge&logo=webrtc)

<br/>
</div>

## 📄 Sobre o Projeto

O **DTOM.net** é uma plataforma web de comunicação em tempo real projetada para conectar amigos através de música e voz. Diferente de soluções tradicionais, o foco aqui é a **sincronização perfeita de mídia**: quando um usuário dá play, pausa ou pula uma música, a ação é replicada instantaneamente para todos na sala.

O sistema utiliza uma arquitetura híbrida:
1.  **Client-Server (SignalR):** Para chat, estado da música e sinalização (signaling).
2.  **Peer-to-Peer (WebRTC):** Para transmissão de voz em baixa latência (topologia Mesh).

---

## 🚀 Funcionalidades Principais

### 🎵 Sincronização de Música (YouTube)
- **Controle Global:** Play, Pause, Seek e Skip sincronizados entre todos os clientes.
- **Fila Dinâmica:** Sistema de fila de reprodução gerenciada em memória.
- **Auto-Skip Inteligente:** Detecção automática de vídeos com restrição de direitos autorais (Erro 150/101), pulando para a próxima faixa sem travar a sala.

### 🎙️ Chat de Voz (WebRTC)
- **Topologia Mesh:** Conexão direta entre navegadores para menor latência.
- **Lógica "Polite Peer":** Algoritmo de negociação de conexão robusto que evita colisões (glare) e suporta múltiplos usuários simultâneos.
- **Feedback Visual (Glow):** Análise de espectro de áudio em tempo real para indicar visualmente quem está falando.

### 🎛️ Interface e Controles
- **Mixer de Áudio:** Controle individual de volume para YouTube, Microfone e Voz dos Participantes.
- **Tema Dark:** Interface moderna construída com Bootstrap 5 e CSS customizado.

---

## 🛠️ Tecnologias Utilizadas

### Back-End
- **C# .NET 8**: Core da aplicação.
- **SignalR**: Websockets para comunicação bidirecional e gerenciamento de estado da sala (Hubs).
- **Concurrent Collections**: Gerenciamento thread-safe de usuários e filas.

### Front-End
- **JavaScript (ES6+)**: Lógica de cliente, manipulação de DOM e Web Audio API.
- **WebRTC API**: `RTCPeerConnection`, `RTCSessionDescription` e `ICE Candidates`.
- **YouTube IFrame API**: Controle do player de vídeo.
- **Bootstrap 5**: Estilização responsiva.

### DevOps & Infra
- **Azure App Service**: Hospedagem da aplicação.
- **GitHub Actions**: Pipeline de CI/CD configurado para deploy automático via Visual Studio.

---

## 🧠 Desafios e Soluções (Architecture Highlights)

### O Problema da Conexão em Grupo (Mesh)
**Desafio:** Em salas com mais de 3 pessoas, as conexões WebRTC falhavam devido a condições de corrida (Race Conditions) onde dois usuários tentavam iniciar a conexão ao mesmo tempo.
**Solução:** Implementação do padrão **"Polite Peer"** com desempate via comparação de IDs (`localeCompare`). O servidor coordena quem entra (`UserJoined`), mas os clientes decidem matematicamente quem deve ceder (`rollback`) em caso de colisão de ofertas.

### Sincronização de Estado
**Desafio:** Garantir que um usuário que entrou tarde na sala ouça a música no ponto exato.
**Solução:** O Hub mantém um snapshot do estado (`StartTime`, `IsPaused`, `CurrentVideo`). Ao conectar, o cliente recebe esse payload e calcula o `seek` exato compensando a latência.

---

## 💻 Como Executar Localmente

### Pré-requisitos
- .NET SDK 8.0+
- Visual Studio 2022 ou VS Code

### Passos
1. Clone o repositório:
   ```bash
   git clone https://github.com/nathatargino/DTOM.git
    
2. Restaure as dependências:
   ```bash
   dotnet restore
  
3. Execute o projeto:
   ```bash
   dotnet watch run
  
4. Acesse https://localhost:7193 (ou a porta indicada).


