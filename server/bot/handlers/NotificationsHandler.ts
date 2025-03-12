import { log } from "../../vite";
import { storage } from "../../storage";

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

      // Send role ping without adding @ symbol (bridge will handle formatting)
      await discordBot.sendMessage(channelId, {
        content: `<@&${category.discordRoleId}>`,
        username: "Ticket Bot"
      });

      log(`Successfully pinged role ${category.discordRoleId} for category ${categoryId}`);
    } catch (error) {
      log(`Error pinging role: ${error}`, "error");
    }
  }
}

export const notificationsHandler = new NotificationsHandler();