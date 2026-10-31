export const presets = {
  invoice: {
    label: 'Invoice',
    spec: {
      title: 'Invoice arithmetic',
      integerDigits: 4,
      scale: 2,
      fields: ['subtotal', 'shipping', 'discount', 'total'],
      constraints: ['total = subtotal + shipping - discount']
    },
    valid: { subtotal: '127.50', shipping: '4.95', discount: '10.00', total: '122.45' },
    invalid: { subtotal: '127.50', shipping: '4.95', discount: '10.00', total: '122.46' },
    tamper: { label: 'Add one cent', field: 'total', delta: '0.01' }
  },
  allocation: {
    label: 'Allocation',
    spec: {
      title: 'Percentages must sum to 100',
      integerDigits: 3,
      scale: 2,
      fields: ['research', 'engineering', 'operations'],
      constraints: ['research + engineering + operations = 100.00']
    },
    valid: { research: '33.33', engineering: '33.33', operations: '33.34' },
    invalid: { research: '33.33', engineering: '33.33', operations: '33.33' },
    tamper: { label: 'Lose one hundredth', field: 'operations', delta: '-0.01' }
  },
  carry: {
    label: 'Carry chain',
    spec: {
      title: 'A carry across every decimal place',
      integerDigits: 4,
      scale: 2,
      fields: ['balance', 'deposit', 'result'],
      constraints: ['result = balance + deposit']
    },
    valid: { balance: '999.99', deposit: '0.01', result: '1000.00' },
    invalid: { balance: '999.99', deposit: '0.01', result: '0.00' },
    tamper: { label: 'Drop the carry', field: 'result', delta: '-1000.00' }
  },
  split: {
    label: 'Even split',
    spec: {
      title: 'Each share is a third of the total, rounded down to the cent',
      integerDigits: 4,
      scale: 2,
      fields: ['total', 'share'],
      constraints: ['3 * share <= total', 'total < 3 * share + 0.03']
    },
    valid: { total: '100.00', share: '33.33' },
    invalid: { total: '100.00', share: '33.34' },
    tamper: { label: 'Add one cent', field: 'share', delta: '0.01' }
  }
};

// The recorded benchmarks cover these three equations. The frozen compilers they
// compare against predate inequalities.
export const benchmarked = Object.fromEntries(['invoice', 'allocation', 'carry'].map(name => [name, presets[name]]));
