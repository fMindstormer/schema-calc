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


def elements(root):
    """Map each business term to the XML elements that hold it, and list the lines."""
    if root.tag.endswith('}CrossIndustryInvoice'):
        settlement = root.find(f'{RSM}SupplyChainTradeTransaction/{RAM}ApplicableHeaderTradeSettlement')
        currency = settlement.findtext(f'{RAM}InvoiceCurrencyCode', '').strip()
        summation = settlement.find(f'{RAM}SpecifiedTradeSettlementHeaderMonetarySummation')
        terms = {name: summation.findall(f'{RAM}{cii}')[:1] for name, _, _, cii in TOTALS}
        terms['vatTotal'] = [e for e in summation.findall(f'{RAM}TaxTotalAmount') if e.get('currencyID') == currency]
        lines = [(item.findtext(f'{RAM}AssociatedDocumentLineDocument/{RAM}LineID'),
                  item.find(f'{RAM}SpecifiedLineTradeSettlement/{RAM}SpecifiedTradeSettlementLineMonetarySummation/{RAM}LineTotalAmount'))
                 for item in root.findall(f'{RSM}SupplyChainTradeTransaction/{RAM}IncludedSupplyChainTradeLineItem')]
        return 'CII', terms, lines
    currency = root.findtext(f'{CBC}DocumentCurrencyCode', '').strip()
    totals = root.find(f'{CAC}LegalMonetaryTotal')
    terms = {name: totals.findall(f'{CBC}{ubl}') for name, _, ubl, _ in TOTALS}
    terms['vatTotal'] = [e for e in root.findall(f'{CAC}TaxTotal/{CBC}TaxAmount') if e.get('currencyID') == currency]
    lines = [(line.findtext(f'{CBC}ID'), line.find(f'{CBC}LineExtensionAmount'))
             for line in root.findall(f'{CAC}InvoiceLine') + root.findall(f'{CAC}CreditNoteLine')]
    return 'UBL', terms, lines


def to_json(root):
    _, terms, lines = elements(root)
    record = {}
    for name, found in terms.items():
        # An absent optional term is omitted. Two VAT totals in the document currency
        # have no place in the form, so both are kept and the schema rejects the type.
        if len(found) == 1:
            record[name] = amount(found[0].text)
        elif len(found) > 1:
            record[name] = [amount(e.text) for e in found]
    record['lines'] = [{'id': (line_id or '').strip(), 'netAmount': amount(net.text) if net is not None else None} for line_id, net in lines]
    return record


# Each change adds one cent to the named terms. Pairs keep one rule true while breaking another.
CHANGES = [['lineNetTotal'], ['allowanceTotal'], ['chargeTotal'], ['totalWithoutVat'], ['vatTotal'], ['totalWithVat'],
           ['paidAmount'], ['roundingAmount'], ['amountDue'], ['line'],
           ['line', 'lineNetTotal'], ['totalWithVat', 'amountDue'], ['totalWithoutVat', 'totalWithVat', 'amountDue']]


def mutate(path, outdir):
    namespaces = dict(node for _, node in ET.iterparse(path, events=['start-ns']))
    for prefix, uri in namespaces.items():
        ET.register_namespace(prefix, uri)
    written = []
    for change in CHANGES:
        tree = ET.parse(path)
        _, terms, lines = elements(tree.getroot())
        targets = [lines[0][1] if name == 'line' and lines else (terms.get(name) or [None])[0] for name in change]
        if any(target is None for target in targets) or (change == ['vatTotal'] and len(terms['vatTotal']) != 1):
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
