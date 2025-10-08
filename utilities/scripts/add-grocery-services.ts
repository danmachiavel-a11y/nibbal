import 'dotenv/config';
import { DatabaseStorage } from '../../server/storage';

async function main() {
  const storage = new DatabaseStorage();

  // Create the Grocery submenu
  const grocerySubmenu = await storage.createCategory({
    name: '🛒 Grocery',
    isSubmenu: true,
    questions: [],
    serviceSummary: 'Order groceries and home essentials.',
    displayOrder: 30,
    newRow: false,
  });
  const groceryId = grocerySubmenu.id;

  // Add child services
  await storage.createCategory({
    name: '🛒 Instacart',
    parentId: groceryId,
    questions: ['What groceries do you need?'],
    serviceSummary: 'Order groceries via Instacart.',
    displayOrder: 1,
  });
  await storage.createCategory({
    name: '🪑 IKEA',
    parentId: groceryId,
    questions: ['What IKEA items do you need delivered?'],
    serviceSummary: 'Order IKEA products for delivery.',
    displayOrder: 2,
  });

  console.log('Grocery submenu and services added successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}); 