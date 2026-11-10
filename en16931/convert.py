"""Convert EN 16931 invoices in UBL or CII syntax to the flat JSON form that
en16931/ubl.json and en16931/cii.json describe, and write changed copies of them:
with amounts raised by one cent, VAT amounts moved by up to a unit, or optional
elements removed.

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


def vat(text):
    """Whether a tax scheme or type code names VAT, as normalize-space(upper-case()) reads it."""
    return ' '.join((text or '').upper().split()) == 'VAT'


def elements(root):
    """Map each business term to the XML elements that hold it, and each list to its
    items: (identifier, {field: element}, item element) triples. A VAT category's rate
    is the Schematron's: only when its tax scheme or type code is VAT."""
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
                       {'netAmount': item.find(f'{RAM}SpecifiedLineTradeSettlement/{RAM}SpecifiedTradeSettlementLineMonetarySummation/{RAM}LineTotalAmount')}, item)
                      for item in root.findall(f'{RSM}SupplyChainTradeTransaction/{RAM}IncludedSupplyChainTradeLineItem')],
            'allowances': [(e.findtext(f'{RAM}ReasonCode'), {'amount': e.find(f'{RAM}ActualAmount')}, e) for e in allowances if charge(e) is False],
            'charges': [(e.findtext(f'{RAM}ReasonCode'), {'amount': e.find(f'{RAM}ActualAmount')}, e) for e in allowances if charge(e) is True],
            'vatBreakdown': [(e.findtext(f'{RAM}CategoryCode'), {'taxAmount': e.find(f'{RAM}CalculatedAmount'), 'taxableAmount': e.find(f'{RAM}BasisAmount'),
                              'rate': e.find(f'{RAM}RateApplicablePercent') if vat(e.findtext(f'{RAM}TypeCode')) else None}, e)
                             for e in settlement.findall(f'{RAM}ApplicableTradeTax')],
        }
        return 'CII', terms, lists
    currency = root.findtext(f'{CBC}DocumentCurrencyCode', '').strip()
    totals = root.find(f'{CAC}LegalMonetaryTotal')
    terms = {name: totals.findall(f'{CBC}{ubl}') for name, _, ubl, _ in TOTALS}
    taxes = [e for e in root.findall(f'{CAC}TaxTotal') if (e.find(f'{CBC}TaxAmount') is not None and e.find(f'{CBC}TaxAmount').get('currencyID') == currency)]
    terms['vatTotal'] = [e.find(f'{CBC}TaxAmount') for e in taxes]
    adjustments = root.findall(f'{CAC}AllowanceCharge')
    lists = {
        'lines': [(line.findtext(f'{CBC}ID'), {'netAmount': line.find(f'{CBC}LineExtensionAmount')}, line)
                  for line in root.findall(f'{CAC}InvoiceLine') + root.findall(f'{CAC}CreditNoteLine')],
        'allowances': [(e.findtext(f'{CBC}AllowanceChargeReasonCode'), {'amount': e.find(f'{CBC}Amount')}, e) for e in adjustments if indicator(e.findtext(f'{CBC}ChargeIndicator')) is False],
        'charges': [(e.findtext(f'{CBC}AllowanceChargeReasonCode'), {'amount': e.find(f'{CBC}Amount')}, e) for e in adjustments if indicator(e.findtext(f'{CBC}ChargeIndicator')) is True],
        'vatBreakdown': [(e.findtext(f'{CAC}TaxCategory/{CBC}ID'), {'taxAmount': e.find(f'{CBC}TaxAmount'), 'taxableAmount': e.find(f'{CBC}TaxableAmount'),
                          'rate': e.find(f'{CAC}TaxCategory/{CBC}Percent') if vat(e.findtext(f'{CAC}TaxCategory/{CAC}TaxScheme/{CBC}ID')) else None}, e)
                         for total in taxes[:1] for e in total.findall(f'{CAC}TaxSubtotal')],
    }
    return 'UBL', terms, lists


# The property that names an item: its line number, reason code or VAT category. It
# is not checked. A missing VAT rate is omitted, since the form lets it be absent.
LABELS = {'lines': 'id', 'allowances': 'reason', 'charges': 'reason', 'vatBreakdown': 'category'}
OPTIONAL = {'rate'}


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
        label = LABELS[name]
        record[name] = [{**({label: key.strip()} if key is not None else {}),
                         **{field: amount(value.text) if value is not None else None for field, value in values.items() if value is not None or field not in OPTIONAL}}
                        for key, values, _ in items]
    return record


# Each change adds one cent to the named terms, or removes those written -name: an
# optional total, every item of a list, or the rate of the first VAT category. Pairs
# keep one rule true while breaking another. A change ending @amount adds that amount
# instead: moving the first VAT category's tax amount, and with it the VAT total and
# the totals that include it, tests BR-CO-17 alone, at its tolerance of one unit and,
# for a category without a rate, at the half unit its tax amount must round below.
VAT = ['vatBreakdown', 'vatTotal', 'totalWithVat', 'amountDue']
CHANGES = [['lineNetTotal'], ['allowanceTotal'], ['chargeTotal'], ['totalWithoutVat'], ['vatTotal'], ['totalWithVat'],
           ['paidAmount'], ['roundingAmount'], ['amountDue'], ['lines'], ['allowances'], ['charges'], ['vatBreakdown'],
           ['lines', 'lineNetTotal'], ['allowances', 'allowanceTotal'], ['charges', 'chargeTotal'], ['vatBreakdown', 'vatTotal'],
           ['totalWithVat', 'amountDue'], ['totalWithoutVat', 'totalWithVat', 'amountDue'],
           ['-allowanceTotal'], ['-chargeTotal'], ['-vatTotal'], ['-paidAmount'], ['-roundingAmount'],
           ['-allowances'], ['-charges'], ['-vatBreakdown'],
           ['-allowances', '-allowanceTotal'], ['-charges', '-chargeTotal'], ['-vatBreakdown', '-vatTotal'], ['-vatBreakdown.rate'],
           [*VAT, '@1.00'], [*VAT, '@-1.00'], [*VAT, '@0.50'], [*VAT, '@-0.50']]


def mutate(path, outdir):
    namespaces = dict(node for _, node in ET.iterparse(path, events=['start-ns']))
    for prefix, uri in namespaces.items():
        ET.register_namespace(prefix, uri)
    written = []
    for change in CHANGES:
        tree = ET.parse(path)
        syntax, terms, lists = elements(tree.getroot())
        parent = {child: node for node in tree.getroot().iter() for child in node}
        names = [name for name in change if not name.startswith('@')]
        delta = Decimal(next((name[1:] for name in change if name.startswith('@')), '0.01'))
        if all(name.startswith('-') for name in names):
            def removal(name):
                if '.' in name:
                    # One field of the first item of a list.
                    list_name, field = name.split('.')
                    return [e for e in [lists[list_name][0][1][field]] if e is not None] if lists[list_name] else []
                if name in lists:
                    return [item for _, _, item in lists[name]]
                # Removing a UBL VAT total removes its TaxTotal, which the XML schema requires to have one.
                return [parent[e] if syntax == 'UBL' and name == 'vatTotal' else e for e in terms[name]]
            removed = [removal(name[1:]) for name in names]
            if not all(removed):
                continue
            for element in [e for group in removed for e in group]:
                parent[element].remove(element)
        else:
            # A list's change moves the main amount of its first item.
            targets = [next(iter(lists[name][0][1].values())) if lists.get(name) else None if name in lists else (terms.get(name) or [None])[0] for name in names]
            if any(target is None for target in targets) or ('vatTotal' in names and len(terms['vatTotal']) != 1):
                continue
            for target in targets:
                target.text = str(Decimal(target.text.strip()) + delta)
        out = Path(outdir) / f'{Path(path).stem}+{"+".join(names)}{"" if delta == Decimal("0.01") else f"@{delta}"}.xml'
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
