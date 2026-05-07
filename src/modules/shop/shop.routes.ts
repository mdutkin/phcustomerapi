// OTC shop — list + detail. Unauthenticated browsing OK; cart needs auth.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { otcProducts } from "@/db/schema";
import { HttpError } from "@/plugins/error-handler";

const Product = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  category: z.string(),
  pack: z.string().nullable(),
  price: z.string(),
  salePrice: z.string().nullable(),
  rating: z.string().nullable(),
  iconKey: z.string().nullable(),
  inStock: z.boolean(),
});

export const shopRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/shop/products", {
    schema: {
      tags: ["shop"],
      querystring: z.object({ category: z.string().optional() }),
      response: { 200: z.object({ items: z.array(Product) }) },
    },
  }, async (req) => {
    const conditions = [eq(otcProducts.inStock, true)];
    if (req.query.category) conditions.push(eq(otcProducts.category, req.query.category));

    const rows = await db
      .select()
      .from(otcProducts)
      .where(and(...conditions));

    return {
      items: rows.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        category: p.category,
        pack: p.pack,
        price: p.price,
        salePrice: p.salePrice,
        rating: p.rating,
        iconKey: p.iconKey,
        inStock: p.inStock,
      })),
    };
  });

  app.get("/shop/products/:id", {
    schema: {
      tags: ["shop"],
      params: z.object({ id: z.string().uuid() }),
      response: { 200: Product.extend({ description: z.string().nullable() }) },
    },
  }, async (req) => {
    const [p] = await db
      .select()
      .from(otcProducts)
      .where(eq(otcProducts.id, req.params.id))
      .limit(1);
    if (!p) throw new HttpError(404, "product_not_found");
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      category: p.category,
      pack: p.pack,
      price: p.price,
      salePrice: p.salePrice,
      rating: p.rating,
      iconKey: p.iconKey,
      inStock: p.inStock,
      description: p.description,
    };
  });
};
