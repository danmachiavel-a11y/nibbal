import 'dotenv/config';
import { DatabaseStorage } from '../../server/storage';

async function main() {
  const storage = new DatabaseStorage();

  // Create the Food submenu
  const foodSubmenu = await storage.createCategory({
    name: '🍔 Food',
    isSubmenu: true,
    questions: [],
    serviceSummary: 'Order food from your favorite service.',
    displayOrder: 10,
    newRow: false,
  });
  const foodId = foodSubmenu.id;

  // Add child services
  await storage.createCategory({
    name: '🚗 Uber Eats',
    parentId: foodId,
    questions: ['What would you like to order?'],
    serviceSummary: 'Order from Uber Eats.',
    displayOrder: 1,
  });
  await storage.createCategory({
    name: '🍔 DoorDash',
    parentId: foodId,
    questions: ['What would you like to order?'],
    serviceSummary: 'Order from DoorDash.',
    displayOrder: 2,
  });
  await storage.createCategory({
    name: '🍟 Grubhub',
    parentId: foodId,
    questions: ['What would you like to order?'],
    serviceSummary: 'Order from Grubhub.',
    displayOrder: 3,
  });
  await storage.createCategory({
    name: '🌶️ Chipotle',
    parentId: foodId,
    questions: ['What would you like to order?'],
    serviceSummary: 'Order from Chipotle.',
    displayOrder: 4,
  });
  await storage.createCategory({
    name: '🍗 Wingstop',
    parentId: foodId,
    questions: ['What would you like to order?'],
    serviceSummary: 'Order from Wingstop.',
    displayOrder: 5,
  });
  await storage.createCategory({
    name: '🐼 Panda Express',
    parentId: foodId,
    questions: ['What would you like to order?'],
    serviceSummary: 'Order from Panda Express.',
    displayOrder: 6,
  });
  await storage.createCategory({
    name: '🍔 Five Guys',
    parentId: foodId,
    questions: ['What would you like to order?'],
    serviceSummary: 'Order from Five Guys.',
    displayOrder: 7,
  });

  console.log('Food submenu and services added!');
}

main().catch((err) => {
  console.error('Error adding food services:', err);
  process.exit(1);
}); 