# bcftools Workflow

1. Add one or more VCF/BCF inputs.
2. Add `bcftools view`, `bcftools filter`, or `bcftools merge` nodes.
3. Connect files in order and choose output file nodes for final artifacts.
4. Use merge nodes when fan-out results need to collapse into a single file.
5. Validate and run.

Use compressed `.vcf.gz` files when possible so indexing and downstream filtering stay efficient.
