import type { billingCustomers } from "../../db/schema.js";

export type BillingCustomer = typeof billingCustomers.$inferSelect;
