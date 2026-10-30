// Runs one Java validator over a corpus with its default options and prints the
// shared result format (see compat/README.md). Usage: java Run <validator> <corpus.json> [first group]
import com.github.erosb.jsonsKema.SchemaLoader;
import com.networknt.schema.InputFormat;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import dev.harrel.jsonschema.ValidatorFactory;
import java.io.File;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.function.Predicate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

public class Run {
  interface Preparer { Predicate<String> prepare(String schema, int index) throws Exception; }

  record Validator(String artifact, String versionKey, Preparer preparer) {}

  static final Map<String, Validator> VALIDATORS = Map.of(
      "networknt", new Validator("com.networknt:json-schema-validator", "networknt", (schema, index) -> {
        var compiled = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
            .getSchema(schema, InputFormat.JSON);
        return data -> compiled.validate(data, InputFormat.JSON).isEmpty();
      }),
      "harrel", new Validator("dev.harrel:json-schema", "harrel", (schema, index) -> {
        var validator = new ValidatorFactory().createValidator();
        URI uri = validator.registerSchema(URI.create("https://schema-calc.invalid/compat/" + index + ".json"), schema);
        return data -> validator.validate(uri, data).isValid();
      }),
      "json-sKema", new Validator("com.github.erosb:json-sKema", "json-sKema", (schema, index) -> {
        var validator = com.github.erosb.jsonsKema.Validator.forSchema(new SchemaLoader(schema).load());
        return data -> validator.validate(data, URI.create("https://schema-calc.invalid/compat/input.json")) == null;
      }));

  public static void main(String[] args) throws Exception {
    Validator v = args.length == 2 || args.length == 3 ? VALIDATORS.get(args[0]) : null;
    if (v == null) {
      System.err.println("usage: java Run <" + String.join("|", VALIDATORS.keySet()) + "> <corpus.json> [first group]");
      System.exit(2);
    }
    ObjectMapper mapper = JsonMapper.builder().build();
    JsonNode corpus = mapper.readTree(new File(args[1]));
    var versions = new Properties();
    try (var in = Run.class.getResourceAsStream("/versions.properties")) { versions.load(in); }
    Map<String, Object> header = new LinkedHashMap<>();
    header.put("validator", v.artifact());
    header.put("version", versions.getProperty(v.versionKey()));
    header.put("language", "Java");
    header.put("runtime", "Java " + Runtime.version());
    emit(mapper, header);
    for (int index = args.length == 3 ? Integer.parseInt(args[2]) : 0; index < corpus.size(); index++) {
      JsonNode group = corpus.get(index);
      JsonNode cases = group.get("cases");
      long started = System.nanoTime();
      int falseAccepts = 0, falseRejects = 0, caseErrors = 0;
      String error = null, caseError = null;
      Double loadSeconds = null;
      try {
        Predicate<String> check = v.preparer().prepare(mapper.writeValueAsString(group.get("schema")), index);
        loadSeconds = (System.nanoTime() - started) / 1e9;
        emit(mapper, Map.of("heartbeat", index, "done", 0));
        int done = 0;
        for (JsonNode c : cases) {
          if (done > 0 && done % 100 == 0) emit(mapper, Map.of("heartbeat", index, "done", done));
          done++;
          boolean expected = c.get("expected").asBoolean();
          boolean actual;
          try { actual = check.test(mapper.writeValueAsString(c.get("data"))); }
          catch (Exception | StackOverflowError e) {
            caseErrors++;
            if (caseError == null) caseError = message(e);
            continue;
          }
          if (actual && !expected) falseAccepts++;
          if (!actual && expected) falseRejects++;
        }
      } catch (Exception | StackOverflowError e) {
        error = message(e);
      }
      Map<String, Object> result = new LinkedHashMap<>();
      result.put("index", index);
      result.put("name", group.get("name").asString());
      result.put("cases", cases.size());
      result.put("falseAccepts", falseAccepts);
      result.put("falseRejects", falseRejects);
      result.put("caseErrors", caseErrors);
      result.put("caseError", caseError);
      result.put("error", error);
      result.put("loadSeconds", loadSeconds);
      result.put("seconds", (System.nanoTime() - started) / 1e9);
      emit(mapper, result);
    }
  }

  static String message(Throwable e) {
    String message = e.getMessage() != null ? e.getClass().getSimpleName() + ": " + e.getMessage() : e.toString();
    return message.substring(0, Math.min(300, message.length()));
  }

  static void emit(ObjectMapper mapper, Object value) {
    System.out.println(mapper.writeValueAsString(value));
    System.out.flush();
  }
}
