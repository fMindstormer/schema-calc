// Run the official EN 16931 Schematron, compiled to XSLT, on invoices. Reads one
// XML path per line from stdin and prints a JSON line per invoice with the IDs of
// its failed assertions and the median time of one validation, after warming up.
// The XSLT is compiled once and each invoice is parsed once, outside the timing.
//
//   java -cp <Saxon-HE and xmlresolver jars> en16931/Schematron.java STYLESHEET.xslt REPEAT < paths
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.TreeSet;
import javax.xml.transform.stream.StreamSource;
import net.sf.saxon.s9api.DocumentBuilder;
import net.sf.saxon.s9api.Processor;
import net.sf.saxon.s9api.XPathSelector;
import net.sf.saxon.s9api.XdmDestination;
import net.sf.saxon.s9api.XdmItem;
import net.sf.saxon.s9api.XdmNode;
import net.sf.saxon.s9api.Xslt30Transformer;
import net.sf.saxon.s9api.XsltExecutable;

public class Schematron {
  public static void main(String[] args) throws Exception {
    Processor processor = new Processor(false);
    long start = System.nanoTime();
    XsltExecutable stylesheet = processor.newXsltCompiler().compile(new StreamSource(new File(args[0])));
    System.out.printf("{\"compileMs\":%.1f}%n", (System.nanoTime() - start) / 1e6);
    int repeat = Integer.parseInt(args[1]);
    var xpath = processor.newXPathCompiler();
    xpath.declareNamespace("svrl", "http://purl.oclc.org/dsdl/svrl");
    var failedIds = xpath.compile("//svrl:failed-assert/@id");
    DocumentBuilder builder = processor.newDocumentBuilder();
    BufferedReader paths = new BufferedReader(new InputStreamReader(System.in));
    for (String path; (path = paths.readLine()) != null && !path.isBlank(); ) {
      XdmNode invoice = builder.build(new File(path));
      TreeSet<String> failed = new TreeSet<>();
      double[] times = new double[repeat];
      for (int i = -repeat; i < repeat; i++) {
        Xslt30Transformer transformer = stylesheet.load30();
        XdmDestination report = new XdmDestination();
        long t = System.nanoTime();
        transformer.applyTemplates(invoice, report);
        double ms = (System.nanoTime() - t) / 1e6;
        if (i < 0) continue;
        times[i] = ms;
        if (i == 0) {
          XPathSelector selector = failedIds.load();
          selector.setContextItem(report.getXdmNode());
          for (XdmItem id : selector) failed.add(id.getStringValue());
        }
      }
      Arrays.sort(times);
      List<String> quoted = new ArrayList<>();
      for (String id : failed) quoted.add("\"" + id.replace("\"", "\\\"") + "\"");
      System.out.printf("{\"file\":\"%s\",\"failed\":[%s],\"medianMs\":%.3f}%n",
        path.replace("\\", "\\\\").replace("\"", "\\\""), String.join(",", quoted), times[repeat / 2]);
    }
  }
}
