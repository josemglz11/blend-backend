// src/seed.js
// Seeds the catalog: protein bases, flavors, add-ins.
// Run once after your first migration: npm run db:seed

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding catalog...');

  // Protein Bases
  await prisma.proteinBase.createMany({
    skipDuplicates: true,
    data: [
      {
        slug:        'whey_isolate',
        name:        'Whey Isolate',
        description: 'Fast-absorbing, 90%+ protein by weight. Mixes clean. Best post-workout.',
        isDairy:     true,
        isVegan:     false,
        calPer25g:   110,
        carbsPer25g: 2.0,
        fatPer25g:   1.0,
        basePrice:   29.99,
      },
      {
        slug:        'vegan_blend',
        name:        'Vegan Blend',
        description: 'Pea, rice, and pumpkin. Complete amino acid profile. Dairy-free.',
        isDairy:     false,
        isVegan:     true,
        calPer25g:   120,
        carbsPer25g: 5.0,
        fatPer25g:   2.0,
        basePrice:   32.99,
      },
      {
        slug:        'casein',
        name:        'Slow-Release Casein',
        description: 'Sustained 6 to 8 hour protein release. Ideal before sleep or as a meal.',
        isDairy:     true,
        isVegan:     false,
        calPer25g:   120,
        carbsPer25g: 4.0,
        fatPer25g:   2.0,
        basePrice:   31.99,
      },
    ],
  });

  // Flavors
  await prisma.flavor.createMany({
    skipDuplicates: true,
    data: [
      { slug: 'chocolate',   name: 'Chocolate',   hexColor: '#3d1f0f' },
      { slug: 'vanilla',     name: 'Vanilla',      hexColor: '#c9a96e' },
      { slug: 'strawberry',  name: 'Strawberry',   hexColor: '#c0392b' },
      { slug: 'coffee',      name: 'Coffee',       hexColor: '#4a2c0a' },
      { slug: 'unflavored',  name: 'Unflavored',   hexColor: '#888880' },
    ],
  });

  // Add-ins
  await prisma.addIn.createMany({
    skipDuplicates: true,
    data: [
      {
        slug:         'creatine',
        name:         'Creatine Monohydrate',
        description:  '5g per sachet. The most evidence-backed strength supplement on the market.',
        dosageNote:   '1 sachet per day, any time.',
        pricePerBag:  8.00,
      },
      {
        slug:         'electrolytes',
        name:         'Electrolyte Blend',
        description:  'Sodium, potassium, magnesium. For hydration during and after training.',
        dosageNote:   '1 sachet per workout or on hot days.',
        pricePerBag:  7.00,
      },
      {
        slug:         'enzymes',
        name:         'Digestive Enzymes',
        description:  'Protease, amylase, lactase blend. Improves protein absorption and reduces bloat.',
        dosageNote:   '1 sachet with your shake.',
        pricePerBag:  6.00,
      },
      {
        slug:         'greens',
        name:         'Greens Complex',
        description:  'Spirulina, chlorella, spinach extract. Daily micronutrient support.',
        dosageNote:   '1 sachet per day.',
        pricePerBag:  9.00,
      },
      {
        slug:         'recovery',
        name:         'Recovery Stack',
        description:  'Magnesium glycinate 400mg and ashwagandha 600mg. Sleep quality and cortisol control.',
        dosageNote:   '1 sachet before bed.',
        pricePerBag:  10.00,
      },
    ],
  });

  console.log('Catalog seeded successfully.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
