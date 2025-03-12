import { log } from "../../vite";
import { storage } from "../../storage";
import { TextChannel } from "discord.js";

export class NotificationsHandler {
  // Store category role mappings
  private roleCache: Map<number, string> = new Map();

  async pingRoleForCategory(categoryId: number, channelId: string, discordBot: any): Promise<void> {
    try {
      const category = await storage.getCategory(categoryId);
      if (!category?.discordRoleId) {
        log(`No role ID found for category ${categoryId}`);
        return;
      }

      // Cache the role ID for future use
      this.roleCache.set(categoryId, category.discordRoleId);

      // Remove any @ symbols from the role ID
      const cleanRoleId = category.discordRoleId.replace(/@/g, '');

      // Get the channel using the bot client
      const channel = await discordBot.getClient().channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({
          content: `<@&${cleanRoleId}>`,
          allowedMentions: { roles: [cleanRoleId] }
        });
      }

      log(`Successfully pinged role ${cleanRoleId} for category ${categoryId}`);
    } catch (error) {
      log(`Error pinging role: ${error}`, "error");
    }
  }
}

export const notificationsHandler = new NotificationsHandler();