// Runs one Go validator over a corpus with its default options and prints the
// shared result format (see compat/README.md). Usage: compat-go <validator> <corpus.json> [first group]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"time"

	kaptinlin "github.com/kaptinlin/jsonschema"
	santhosh "github.com/santhosh-tekuri/jsonschema/v6"
)

type group struct {
	Name   string          `json:"name"`
	Schema json.RawMessage `json:"schema"`
	Cases  []struct {
		Data     json.RawMessage `json:"data"`
		Expected bool            `json:"expected"`
	} `json:"cases"`
}

type result struct {
	Index        int     `json:"index"`
	Name         string  `json:"name"`
	Cases        int     `json:"cases"`
	FalseAccepts int     `json:"falseAccepts"`
	FalseRejects int     `json:"falseRejects"`
	CaseErrors   int     `json:"caseErrors"`
	CaseError    *string `json:"caseError"`
	LoadSeconds  float64 `json:"loadSeconds,omitempty"`
	Error        *string `json:"error"`
	Seconds      float64 `json:"seconds"`
}

type checker func(data []byte) (bool, error)

type validator struct {
	module  string
	prepare func(schema []byte, index int) (checker, error)
}

func santhoshPrepare(schema []byte, index int) (checker, error) {
	doc, err := santhosh.UnmarshalJSON(bytes.NewReader(schema))
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("https://schema-calc.invalid/compat/%d.json", index)
	c := santhosh.NewCompiler()
	if err := c.AddResource(url, doc); err != nil {
		return nil, err
	}
	sch, err := c.Compile(url)
	if err != nil {
		return nil, err
	}
	return func(data []byte) (bool, error) {
		inst, err := santhosh.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			return false, err
		}
		return sch.Validate(inst) == nil, nil
	}, nil
}

var validators = map[string]validator{
	"santhosh-tekuri": {"github.com/santhosh-tekuri/jsonschema/v6", santhoshPrepare},
	"kaptinlin": {"github.com/kaptinlin/jsonschema", func(schema []byte, index int) (checker, error) {
		sch, err := kaptinlin.NewCompiler().Compile(schema, fmt.Sprintf("https://schema-calc.invalid/compat/%d.json", index))
		if err != nil {
			return nil, err
		}
		return func(data []byte) (bool, error) { return sch.ValidateJSON(data).IsValid(), nil }, nil
	}},
}

func moduleVersion(path string) string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == path {
				return dep.Version
			}
		}
	}
	return "unknown"
}

func truncate(s string) *string {
	if len(s) > 300 {
		s = s[:300]
	}
	return &s
}

func emit(value any) {
	out, _ := json.Marshal(value)
	fmt.Println(string(out))
}

func main() {
	v, ok := validators[""]
	first := 0
	if len(os.Args) == 3 || len(os.Args) == 4 {
		v, ok = validators[os.Args[1]]
	}
	if ok && len(os.Args) == 4 {
		var err error
		first, err = strconv.Atoi(os.Args[3])
		ok = err == nil
	}
	if !ok {
		fmt.Fprintln(os.Stderr, "usage: compat-go <santhosh-tekuri|kaptinlin> <corpus.json> [first group]")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	var corpus []group
	if err := json.Unmarshal(raw, &corpus); err != nil {
		panic(err)
	}
	emit(map[string]any{
		"validator": v.module, "version": moduleVersion(v.module), "language": "Go",
		"runtime": runtime.Version(),
	})
	for i := first; i < len(corpus); i++ {
		g := corpus[i]
		started := time.Now()
		r := result{Index: i, Name: g.Name, Cases: len(g.Cases)}
		check, err := v.prepare(g.Schema, i)
		if err != nil {
			r.Error = truncate(err.Error())
		} else {
			r.LoadSeconds = time.Since(started).Seconds()
			emit(map[string]int{"heartbeat": i, "done": 0})
			for done, c := range g.Cases {
				if done > 0 && done%100 == 0 {
					emit(map[string]int{"heartbeat": i, "done": done})
				}
				actual, err := check(c.Data)
				switch {
				case err != nil:
					r.CaseErrors++
					if r.CaseError == nil {
						r.CaseError = truncate(err.Error())
					}
				case actual && !c.Expected:
					r.FalseAccepts++
				case !actual && c.Expected:
					r.FalseRejects++
				}
			}
		}
		r.Seconds = time.Since(started).Seconds()
		emit(r)
	}
}
