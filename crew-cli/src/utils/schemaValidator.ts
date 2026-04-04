/** Stub — SchemaValidator validates tool input parameters against JSON schema. */
export class SchemaValidator {
  validate(_schema: unknown, _data: unknown): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }
}
