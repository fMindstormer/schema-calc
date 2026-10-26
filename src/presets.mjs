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
    invalidLabel: 'Add one cent'
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
    invalidLabel: 'Lose one hundredth'
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
    invalidLabel: 'Drop the carry'
  }
};
