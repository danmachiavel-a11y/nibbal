
import { Client, GatewayIntentBits } from 'discord.js';

// Skip loading from .env, use direct value
process.env.DISCORD_BOT_TOKEN = "MTA4NzM5MjAzMDk3OTAxMDU2MA.GuM4po.tYOZqTMm5v56LI-D7mwzL5NtC6YwSw8GRgIKSQ";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

console.log("Testing Discord connection with token from .env file...");
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => {
    console.log("✅ SUCCESS: Connected to Discord!");
    console.log(`Connected as: ${client.user.tag}`);
    setTimeout(() => {
      client.destroy();
      process.exit(0);
    }, 1000);
  })
  .catch(error => {
    console.error("❌ Connection failed:", error.message);
    process.exit(1);
  });
  