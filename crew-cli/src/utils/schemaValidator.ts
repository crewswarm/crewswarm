/** Stub — SchemaValidator validates tool input parameters against JSON schema. */
export class SchemaValidator {
  validate(_schema: any, _data: any): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }
}
