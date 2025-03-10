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

      // Send role ping through bridge manager
      await discordBot.getClient().channels.fetch(channelId).then(channel => {
        if (channel?.isTextBased()) {
          (channel as any).send({
            content: `<@&${category.discordRoleId}>`,
            allowedMentions: { roles: [category.discordRoleId] }
          });
        }
      });

      log(`Successfully pinged role ${category.discordRoleId} for category ${categoryId}`);
    } catch (error) {
      log(`Error pinging role: ${error}`, "error");
    }
  }
}

export const notificationsHandler = new NotificationsHandler();