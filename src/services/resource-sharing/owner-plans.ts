import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { subscriptionPlans } from "../../db/schema.js";

export interface OwnerPlanSummary {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

/**
 * Plans an owner may reference from a resource, grant or invitation. The
 * application is always the one resolved by the delegated guard, so this is
 * not a broader catalog read.
 */
export async function listOwnerPlans(
  ownerApplicationId: string,
): Promise<OwnerPlanSummary[]> {
  return db
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      description: subscriptionPlans.description,
      isDefault: subscriptionPlans.isDefault,
    })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.applicationId, ownerApplicationId))
    .orderBy(asc(subscriptionPlans.name));
}
