// `genesispay.customers.*` — reusable billing contacts over `/api/v1/customers`.

import { GenesisPayConfigError } from "./errors.js";
import {
  asRecord,
  optionalMetadata,
  optionalString,
  requiredString,
  type GenesisPayRequest,
} from "./resource.js";

export type Customer = {
  id: string;
  publicId: string;
  name: string;
  email: string;
  companyName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string | null;
  taxId: string | null;
  metadata: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CustomerCreateInput = {
  name: string;
  email: string;
  companyName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  taxId?: string;
  metadata?: Record<string, string>;
};

export type CustomerUpdateInput = Partial<CustomerCreateInput>;

export interface CustomersResource {
  create(input: CustomerCreateInput): Promise<Customer>;
  list(): Promise<Customer[]>;
  retrieve(publicId: string): Promise<Customer>;
  update(publicId: string, input: CustomerUpdateInput): Promise<Customer>;
  archive(publicId: string): Promise<Customer>;
}

export function createCustomersResource(request: GenesisPayRequest): CustomersResource {
  return {
    create: async (input) =>
      customerRequest(request, "POST", "/api/v1/customers", input, "create a customer"),
    list: async () => {
      const body = await request({
        path: "/api/v1/customers",
        operation: "GET /api/v1/customers",
        action: "list customers",
      });
      const rows = asRecord(body)?.customers;
      if (!Array.isArray(rows)) {
        throw new GenesisPayConfigError(
          `GenesisPay GET /api/v1/customers returned no customers array: ${JSON.stringify(body)}`,
        );
      }
      return rows
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => Boolean(row?.publicId))
        .map(toCustomer);
    },
    retrieve: async (publicId) => {
      const id = requirePublicId(publicId, "customers.retrieve");
      return customerRequest(
        request,
        "GET",
        `/api/v1/customers/${encodeURIComponent(id)}`,
        undefined,
        `retrieve customer "${id}"`,
      );
    },
    update: async (publicId, input) => {
      const id = requirePublicId(publicId, "customers.update");
      return customerRequest(
        request,
        "PATCH",
        `/api/v1/customers/${encodeURIComponent(id)}`,
        input,
        `update customer "${id}"`,
      );
    },
    archive: async (publicId) => {
      const id = requirePublicId(publicId, "customers.archive");
      return customerRequest(
        request,
        "POST",
        `/api/v1/customers/${encodeURIComponent(id)}/archive`,
        undefined,
        `archive customer "${id}"`,
      );
    },
  };
}

async function customerRequest(
  request: GenesisPayRequest,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body: unknown,
  action: string,
): Promise<Customer> {
  const response = await request({
    method,
    path,
    operation: `${method} ${path}`,
    action,
    ...(body === undefined ? {} : { body }),
  });
  const raw = asRecord(asRecord(response)?.customer);
  if (!raw?.publicId) {
    throw new GenesisPayConfigError(
      `GenesisPay ${method} ${path} returned no customer: ${JSON.stringify(response)}`,
    );
  }
  return toCustomer(raw);
}

function requirePublicId(publicId: string, method: string): string {
  const id = publicId?.trim();
  if (!id) {
    throw new GenesisPayConfigError(
      `${method}(publicId) requires the publicId returned by customers.create().`,
    );
  }
  return id;
}

export function toCustomer(raw: Record<string, unknown>): Customer {
  return {
    id: requiredString(raw.id),
    publicId: requiredString(raw.publicId),
    name: requiredString(raw.name),
    email: requiredString(raw.email),
    companyName: optionalString(raw.companyName),
    addressLine1: optionalString(raw.addressLine1),
    addressLine2: optionalString(raw.addressLine2),
    city: optionalString(raw.city),
    postalCode: optionalString(raw.postalCode),
    countryCode: optionalString(raw.countryCode),
    taxId: optionalString(raw.taxId),
    metadata: optionalMetadata(raw.metadata),
    createdAt: requiredString(raw.createdAt),
    updatedAt: requiredString(raw.updatedAt),
    archivedAt: optionalString(raw.archivedAt),
  };
}
