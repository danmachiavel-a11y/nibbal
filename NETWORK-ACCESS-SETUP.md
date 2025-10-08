# Network Access Setup Guide

## Overview
Your bot server is now configured to be accessible from both localhost and your server's IP address. Here's how to set it up properly.

## Current Configuration
- **Host**: `0.0.0.0` (accessible from any IP address)
- **Port**: `5000` (configurable via environment variables)
- **Local Access**: `http://localhost:5000`
- **Network Access**: `http://[YOUR_SERVER_IP]:5000`

## Step 1: Find Your Server's IP Address

### Option A: Use the provided script
```bash
node utilities/scripts/get-server-ip.js
```

### Option B: Manual commands
**Linux/Mac:**
```bash
ip addr show
# or
hostname -I
```

**Windows:**
```cmd
ipconfig
```

## Step 2: Configure Firewall

### Windows (Windows Defender Firewall)
1. Open Windows Defender Firewall
2. Click "Advanced settings"
3. Click "Inbound Rules" → "New Rule"
4. Select "Port" → Next
5. Select "TCP" → Specific local ports: `5000` → Next
6. Select "Allow the connection" → Next
7. Apply to all profiles → Next
8. Name: "Bot Server Port 5000" → Finish

### Linux (UFW)
```bash
# Allow port 5000
sudo ufw allow 5000

# Check status
sudo ufw status
```

### Linux (iptables)
```bash
# Allow port 5000
sudo iptables -A INPUT -p tcp --dport 5000 -j ACCEPT

# Save rules (Ubuntu/Debian)
sudo iptables-save > /etc/iptables/rules.v4
```

### macOS
```bash
# Allow port 5000
sudo pfctl -f /etc/pf.conf
```

## Step 3: Test Network Access

1. **Start your bot server**
2. **Find your IP address** using the script above
3. **Test from another device** on the same network:
   - Open browser on phone/tablet/other computer
   - Go to `http://[YOUR_SERVER_IP]:5000`
   - You should see your bot's web interface

## Environment Variables (Optional)

You can customize the server configuration by adding these to your `.env` file:

```env
# Server configuration
PORT=5000                    # Server port (default: 5000)
HOST=0.0.0.0                # Server host (default: 0.0.0.0)
SERVER_PORT=5000            # Alternative port variable
SERVER_HOST=0.0.0.0         # Alternative host variable
```

## Troubleshooting

### Can't access from other devices?
1. **Check firewall**: Make sure port 5000 is open
2. **Check network**: Ensure devices are on the same network
3. **Check IP address**: Verify you're using the correct IP
4. **Check server logs**: Look for any error messages

### Port already in use?
```bash
# Find what's using port 5000
netstat -tulpn | grep :5000

# Kill the process (replace PID with actual process ID)
kill -9 PID
```

### Server not starting?
1. Check if all required environment variables are set
2. Check database connection
3. Check bot tokens are valid

## Security Considerations

⚠️ **Important**: Making your server accessible on the network means it can be accessed by anyone on your local network.

### For Production Use:
1. **Use HTTPS**: Set up SSL certificates
2. **Authentication**: Add login/password protection
3. **VPN**: Use VPN for remote access
4. **Firewall**: Restrict access to specific IP ranges

### For Development:
- The current setup is fine for local network testing
- Don't expose to the internet without proper security

## Quick Commands

```bash
# Find server IP
node utilities/scripts/get-server-ip.js

# Start server with custom port
PORT=8080 npm start

# Start server with custom host
HOST=192.168.1.100 npm start

# Check if port is open
telnet YOUR_SERVER_IP 5000
```

## Success Indicators

When everything is working correctly, you should see:
```
🚀 Server listening on 0.0.0.0:5000 (DEVELOPMENT mode)
📱 Local access: http://localhost:5000
🌐 Network access: http://[YOUR_SERVER_IP]:5000
💡 To find your server IP, run: node utilities/scripts/get-server-ip.js
```

And you should be able to access your bot from any device on your network using the server's IP address!
