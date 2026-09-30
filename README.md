# JTG Panel

Made by Jishnu

## Quick Automated Setup (Recommended)

Run the automated management script:

```bash
bash install.sh
```

Menu Options:
1. **Install Panel** (Installs Node.js, Docker, PM2, dependencies, builds & starts on port 6767)
2. **Update Panel**
3. **Create Admin User**
4. **Restart Panel**
5. **Exit**

---

## Manual Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/JishnuTheGamer/Jtg.git
   cd Jtg
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the application:
   ```bash
   npm run build
   ```

4. Create an admin user:
   ```bash
   npm run createuser
   ```

5. Start the server (Port 6767):
   ```bash
   npm run start
   ```

## Wings Node Architecture & Setup

JTG Panel operates as a central control panel that manages one or more Wings daemon nodes running on separate VPS instances.

### Panel & Node Installation Workflow

1. **Install Panel**
   - Run `bash install.sh` or follow manual setup.
   - Start Panel on your main server (e.g. `http://panel.example.com:6767`).

2. **Create a Node**
   - Log into the JTG Panel Admin Dashboard.
   - Go to **Nodes** → **Create Wings Node**.
   - Enter your node's details (Node Name, FQDN / Hostname, Public IPv4, Wings Port, Memory, Disk).

3. **Install Wings on VPS**
   - Open Node Configuration to view the unique installation command.
   - Copy the installation command:
     ```bash
     curl -fsSL https://panel.example.com/api/wings/install | bash -s -- <REGISTRATION_TOKEN>
     ```
   - SSH into your target VPS and run the command.
   - Wings registers with JTG Panel using a single-use token and starts the `jtg-wings` service.
   - The node automatically turns **ONLINE**.

4. **Deploy Game Servers**
   - Go to **Deploy Instance**.
   - Select your registered Wings Node and port allocation.
   - The panel routes lifecycle, console, and file commands to Wings.

## Development

To run the panel in development mode on port 3000:

```bash
npm run dev
```

