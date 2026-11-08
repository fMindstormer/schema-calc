"""Convert EN 16931 invoices in UBL or CII syntax to the flat JSON form that
en16931/contract.json describes, and write one-cent changes of them.

  python3 -I en16931/convert.py json INVOICE.xml          # prints the JSON form
  python3 -I en16931/convert.py lines < PATHS              # one JSON form per line
  python3 -I en16931/convert.py mutate INVOICE.xml OUTDIR  # writes changed copies

Only the standard library is used. The conversion never computes a total: it
copies each business term, rewriting its decimal with exactly two fractional
digits. A value that two digits cannot represent exactly, or that has more than
six integer digits, is copied unchanged, so the schema rejects its format.
"""
import json
import sys
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation
from pathlib import Path

CBC = '{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}'
CAC = '{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}'
RAM = '{urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100}'
RSM = '{urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100}'
UDT = '{urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100}'
INTEGER_DIGITS = 6

# JSON name, business term, UBL element in LegalMonetaryTotal, CII element in the header summation.
TOTALS = [
    ('lineNetTotal', 'BT-106', 'LineExtensionAmount', 'LineTotalAmount'),
    ('allowanceTotal', 'BT-107', 'AllowanceTotalAmount', 'AllowanceTotalAmount'),
    ('chargeTotal', 'BT-108', 'ChargeTotalAmount', 'ChargeTotalAmount'),
    ('totalWithoutVat', 'BT-109', 'TaxExclusiveAmount', 'TaxBasisTotalAmount'),
    ('totalWithVat', 'BT-112', 'TaxInclusiveAmount', 'GrandTotalAmount'),
    ('paidAmount', 'BT-113', 'PrepaidAmount', 'TotalPrepaidAmount'),
    ('roundingAmount', 'BT-114', 'PayableRoundingAmount', 'RoundingAmount'),
    ('amountDue', 'BT-115', 'PayableAmount', 'DuePayableAmount'),
]


def amount(text):
    """The xs:decimal lexical form as a string with exactly two fractional digits."""
    try:
        value = Decimal(text.strip())
    except InvalidOperation:
        return text
    cents = value * 100
    if cents != cents.to_integral_value() or abs(value) >= 10 ** INTEGER_DIGITS:
        return text.strip()
    cents = int(cents)
    return ('-' if cents < 0 else '') + f'{abs(cents) // 100}.{abs(cents) % 100:02d}'


def indicator(text):
    """An xs:boolean as the Schematron compares it: 'true' or '1', 'false' or '0'."""
    return {'true': True, '1': True, 'false': False, '0': False}.get((text or '').strip())


def elements(root):
    """Map each business term to the XML elements that hold it, and each list to the
    elements of its items: (identifier, amount element) pairs."""
    if root.tag.endswith('}CrossIndustryInvoice'):
        settlement = root.find(f'{RSM}SupplyChainTradeTransaction/{RAM}ApplicableHeaderTradeSettlement')
        currency = settlement.findtext(f'{RAM}InvoiceCurrencyCode', '').strip()
        summation = settlement.find(f'{RAM}SpecifiedTradeSettlementHeaderMonetarySummation')
        terms = {name: summation.findall(f'{RAM}{cii}')[:1] for name, _, _, cii in TOTALS}
        terms['vatTotal'] = [e for e in summation.findall(f'{RAM}TaxTotalAmount') if e.get('currencyID') == currency]
        charge = lambda e: indicator(e.findtext(f'{RAM}ChargeIndicator/{UDT}Indicator'))
        allowances = settlement.findall(f'{RAM}SpecifiedTradeAllowanceCharge')
        lists = {
            'lines': [(item.findtext(f'{RAM}AssociatedDocumentLineDocument/{RAM}LineID'),
                       item.find(f'{RAM}SpecifiedLineTradeSettlement/{RAM}SpecifiedTradeSettlementLineMonetarySummation/{RAM}LineTotalAmount'))
                      for item in root.findall(f'{RSM}SupplyChainTradeTransaction/{RAM}IncludedSupplyChainTradeLineItem')],
            'allowances': [(e.findtext(f'{RAM}ReasonCode'), e.find(f'{RAM}ActualAmount')) for e in allowances if charge(e) is False],
            'charges': [(e.findtext(f'{RAM}ReasonCode'), e.find(f'{RAM}ActualAmount')) for e in allowances if charge(e) is True],
            'vatBreakdown': [(e.findtext(f'{RAM}CategoryCode'), e.find(f'{RAM}CalculatedAmount')) for e in settlement.findall(f'{RAM}ApplicableTradeTax')],
        }
        return 'CII', terms, lists
    currency = root.findtext(f'{CBC}DocumentCurrencyCode', '').strip()
    totals = root.find(f'{CAC}LegalMonetaryTotal')
    terms = {name: totals.findall(f'{CBC}{ubl}') for name, _, ubl, _ in TOTALS}
    vat = [e for e in root.findall(f'{CAC}TaxTotal') if (e.find(f'{CBC}TaxAmount') is not None and e.find(f'{CBC}TaxAmount').get('currencyID') == currency)]
    terms['vatTotal'] = [e.find(f'{CBC}TaxAmount') for e in vat]
    adjustments = root.findall(f'{CAC}AllowanceCharge')
    lists = {
        'lines': [(line.findtext(f'{CBC}ID'), line.find(f'{CBC}LineExtensionAmount'))
                  for line in root.findall(f'{CAC}InvoiceLine') + root.findall(f'{CAC}CreditNoteLine')],
        'allowances': [(e.findtext(f'{CBC}AllowanceChargeReasonCode'), e.find(f'{CBC}Amount')) for e in adjustments if indicator(e.findtext(f'{CBC}ChargeIndicator')) is False],
        'charges': [(e.findtext(f'{CBC}AllowanceChargeReasonCode'), e.find(f'{CBC}Amount')) for e in adjustments if indicator(e.findtext(f'{CBC}ChargeIndicator')) is True],
        'vatBreakdown': [(e.findtext(f'{CAC}TaxCategory/{CBC}ID'), e.find(f'{CBC}TaxAmount')) for total in vat[:1] for e in total.findall(f'{CAC}TaxSubtotal')],
    }
    return 'UBL', terms, lists


# Each list's amount field, and the property that names an item: its line number,
# reason code or VAT category. Other properties of an item are not checked.
LISTS = {'lines': ('netAmount', 'id'), 'allowances': ('amount', 'reason'), 'charges': ('amount', 'reason'), 'vatBreakdown': ('taxAmount', 'category')}


def to_json(root):
    _, terms, lists = elements(root)
    record = {}
    for name, found in terms.items():
        # An absent optional term is omitted. Two VAT totals in the document currency
        # have no place in the form, so both are kept and the schema rejects the type.
        if len(found) == 1:
            record[name] = amount(found[0].text)
        elif len(found) > 1:
            record[name] = [amount(e.text) for e in found]
    for name, items in lists.items():
        field, label = LISTS[name]
        record[name] = [{**({label: key.strip()} if key is not None else {}), field: amount(value.text) if value is not None else None}
                        for key, value in items]
    return record


# Each change adds one cent to the named terms. Pairs keep one rule true while breaking another.
CHANGES = [['lineNetTotal'], ['allowanceTotal'], ['chargeTotal'], ['totalWithoutVat'], ['vatTotal'], ['totalWithVat'],
           ['paidAmount'], ['roundingAmount'], ['amountDue'], ['lines'], ['allowances'], ['charges'], ['vatBreakdown'],
           ['lines', 'lineNetTotal'], ['allowances', 'allowanceTotal'], ['charges', 'chargeTotal'], ['vatBreakdown', 'vatTotal'],
           ['totalWithVat', 'amountDue'], ['totalWithoutVat', 'totalWithVat', 'amountDue']]


def mutate(path, outdir):
    namespaces = dict(node for _, node in ET.iterparse(path, events=['start-ns']))
    for prefix, uri in namespaces.items():
        ET.register_namespace(prefix, uri)
    written = []
    for change in CHANGES:
        tree = ET.parse(path)
        _, terms, lists = elements(tree.getroot())
        # A list's change raises its first item.
        targets = [(lists[name][:1] or [(None, None)])[0][1] if name in lists else (terms.get(name) or [None])[0] for name in change]
        if any(target is None for target in targets) or ('vatTotal' in change and len(terms['vatTotal']) != 1):
            continue
        for target in targets:
            target.text = str(Decimal(target.text.strip()) + Decimal('0.01'))
        out = Path(outdir) / f'{Path(path).stem}+{"+".join(change)}.xml'
        tree.write(out, encoding='utf-8', xml_declaration=True)
        written.append(str(out))
    print(json.dumps(written))


if __name__ == '__main__':
    if sys.argv[1] == 'json':
        print(json.dumps(to_json(ET.parse(sys.argv[2]).getroot())))
    elif sys.argv[1] == 'lines':
        for line in sys.stdin:
            if line.strip():
                print(json.dumps(to_json(ET.parse(line.strip()).getroot())))
    elif sys.argv[1] == 'mutate':
        mutate(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
