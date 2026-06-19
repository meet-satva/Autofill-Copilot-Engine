import assert from 'assert';
import { describe, it } from 'node:test';
import { inferCommonField, splitNameParts, extractLastDigits, buildAutoMappings } from '../src/pages/api/autofill/map.js';

describe('Autofill mapping helpers', () => {
  it('should split full name into first, middle, last', () => {
    const result = splitNameParts('Chintan Jayantibhai Prajapati');
    assert.strictEqual(result.firstName, 'Chintan');
    assert.strictEqual(result.middleName, 'Jayantibhai');
    assert.strictEqual(result.lastName, 'Prajapati');
  });

  it('should leave middle name empty when only two parts exist', () => {
    const result = splitNameParts('Manisha Prajapati');
    assert.strictEqual(result.firstName, 'Manisha');
    assert.strictEqual(result.middleName, '');
    assert.strictEqual(result.lastName, 'Prajapati');
  });

  it('should return last 4 digits for Aadhaar last 4 label', () => {
    const value = extractLastDigits('1234 5678 9012', 4);
    assert.strictEqual(value, '9012');
  });

  it('should infer middle name field correctly', () => {
    const field = { labelText: 'Middle name', type: 'text', id: 'middle' };
    const vault = {
      profiles: {
        primary: {
          personalDetails: {
            fullName: 'Chintan Jayantibhai Prajapati',
          },
          identities: {},
        },
      },
      familyTree: {},
    };
    const value = inferCommonField(field, vault, 'Fill this form for Chintan');
    assert.strictEqual(value, 'Jayantibhai');
  });

  it('should infer date of birth field correctly', () => {
    const field = { labelText: 'Date of birth', type: 'date', id: 'dob' };
    const vault = {
      profiles: {
        primary: {
          personalDetails: {
            dob: '1990-01-01',
          },
          identities: {},
        },
      },
      familyTree: {},
    };
    const value = inferCommonField(field, vault, 'Fill this for Chintan');
    assert.strictEqual(value, '1990-01-01');
  });

  it('should infer Aadhaar last 4 digits based on label', () => {
    const field = { labelText: 'Aadhaar last 4 digits', type: 'text', id: 'aadhaarLast4' };
    const vault = {
      profiles: {
        primary: {
          personalDetails: {},
          identities: {
            aadhaar: {
              aadhaarNumber: '1234 5678 9012',
            },
          },
        },
      },
      familyTree: {},
    };
    const value = inferCommonField(field, vault, 'Fill this form for Chintan');
    assert.strictEqual(value, '9012');
  });

  it('should map middle name and date of birth correctly in a DOM schema', () => {
    const domSchema = [
      { id: 'first', name: 'firstName', labelText: 'First name', type: 'text' },
      { id: 'middle', name: 'middleName', labelText: 'Middle name', type: 'text' },
      { id: 'last', name: 'lastName', labelText: 'Last name', type: 'text' },
      { id: 'dob', name: 'dob', labelText: 'Date of birth', type: 'date' },
      { id: 'aadhaarLast4', name: 'aadhaarLast4', labelText: 'Aadhaar last 4 digits', type: 'text' },
    ];

    const vault = {
      profiles: {
        primary: {
          personalDetails: {
            fullName: 'Chintan Jayantibhai Prajapati',
            dob: '1990-01-01',
          },
          identities: {
            aadhaar: {
              aadhaarNumber: '1234 5678 9012',
            },
          },
        },
      },
      familyTree: {},
    };

    const mappings = buildAutoMappings(domSchema, vault, 'Fill this form for Chintan');
    const middle = mappings.find(m => m.fieldName === 'middleName');
    const dob = mappings.find(m => m.fieldName === 'dob');
    const last4 = mappings.find(m => m.fieldName === 'aadhaarLast4');

    assert.strictEqual(middle?.value, 'Jayantibhai');
    assert.strictEqual(dob?.value, '1990-01-01');
    assert.strictEqual(last4?.value, '9012');
    assert.strictEqual(middle?.confidence, 'high');
    assert.strictEqual(dob?.confidence, 'high');
    assert.strictEqual(last4?.confidence, 'high');
  });
});
