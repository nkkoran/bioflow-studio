# Tool Palette Node UX Audit

Date: 2026-05-03

Perspective: cardiologist geneticist building GWAS, GRS, annotation, plotting, and file-management analyses on Rorqual or related backends.

Method: added each palette node to an isolated new pipeline one at a time, selected it, expanded visible advanced sections, and scrolled the inspector. Follow-up pass reviewed each tool registry contract, generated-script behavior, output path planning, analysis-option recommendations, and bundle wiring against the user's expected analysis flow. No jobs were submitted and no remote files were changed.

## Summary

The palette is broadly usable: required inputs are visible, outputs preview final paths, and the inspector consistently exposes execution mode, module override, output folder, and Slurm resources. The main issues were systemic wording/formatting problems rather than missing whole nodes.

Fixed in this pass:

| Finding | Affected nodes | Severity | Fix |
| --- | --- | --- | --- |
| Output File showed input-only split controls and the checkbox label "Input file (vs. output)", which made a sink node look like an input source. | Output File | Degraded | Replaced the checkbox with a File role segmented control and only show split controls on input file nodes. |
| Custom R Script said "This tool has no inputs" even though the script API documents `input_file` and `input_files`. | Custom R Script | Blocking | Custom R now exposes its optional canvas input like Custom Shell. |
| PLINK2 Association treated phenotype as optional, even though association testing needs a phenotype file and trait column for the intended GWAS workflow. | PLINK2 Association | Blocking | Marked phenotype input required and kept the phenotype-column warning visible before run. |
| Optional PLINK covariates appeared too eagerly in a fresh association node. | PLINK2 Association | Degraded | Covariate file and covariate columns now stay opt-in/recommended instead of active by default. |
| PLINK2 `--glm` duplicated "hide covariate rows" as both the selected mode and a checkbox. | PLINK2 Association | Degraded | Added a "Standard association test" main mode and kept "Hide covariate rows" as a separate modifier. |
| Non-CLI/R nodes leaked internal parameter ids in the option cards and preview, e.g. `pCol`, `chrCol`, `linear-lm`. | Plot, summary, regression, CrossMap, UKB | Polish | Hide internal ids in readable previews and display friendly select labels. |
| Select menus used raw tool codes where plain English was needed, e.g. `z`, `b`, `a`, `s`, `linear-lm`, `array-if-list-is-typed`. | bcftools, CrossMap, VEP, R Regression, PLINK PheWAS | Degraded | Added context-aware labels while preserving the exact command value. |
| Plot/table titles were tucked into Advanced even though they are normal analysis outputs. | Plot, Summary Table, R Regression, MultiQC | Polish | Made `title` a normal Output option. |
| Output previews could produce doubled extensions such as `.tsv.tsv`. | Summary Table, UKB Spark Extract, same-shape future ports | Polish | Output path preview and runtime fallback paths now omit duplicate port/ext stems. |
| The tool palette grouped input, output, transform, merge, transfer, and note nodes under "Inputs", which understated sink and utility nodes. | Tool palette core nodes | Polish | Renamed the section to "Core nodes". |

Fixed in the code-level pass:

| Finding | Affected nodes | Severity | Fix |
| --- | --- | --- | --- |
| Recommended optional canvas inputs could be impossible to enable when the same port also had column-selection options, so a user could see covariate selectors without being guided to add the covariate file. | PLINK2 PheWAS, R Regression, CrossMap | Degraded | Analysis-option filtering now keeps optional inputs visible even when a column picker targets the same port; recommended chips can enable canvas inputs. |
| PheWAS recommendations missed phenotype list, covariate file, covariate names, and keep-file controls that are normal GWAS setup tasks. | PLINK2 PheWAS | Degraded | Added these to the recommended option set. |
| CrossMap recommended `reference` did not match the optional input option id, so target reference setup was not surfaced correctly. | CrossMap Liftover | Blocking for VCF/gVCF liftover | Corrected the recommendation to `input:reference`. |
| PLINK2 `--glm` modeled `hide-covar` as the selected test mode, making the command and UI misleading. | PLINK2 Association, PLINK flag builder | Degraded | Split standard/firth modes from `hide-covar`, `omit-ref`, `skip-invalid-pheno`, and legacy migration. |
| PLINK2 Clump advertised range output for scoring, but PLINK2 Score `--extract` expects variant IDs by default. | PLINK2 Clump, PLINK2 Score, GRS bundles | Blocking | Clump now declares and materializes a one-ID-per-line lead variant output, and Score labels the optional extract input as variant IDs. |
| Several tool outputs previewed one path but generated another native tool path, leaving downstream nodes pointed at files that might not exist. | PLINK2 Association, Clump, Score, PCA; REGENIE Step 1/2; ANNOVAR; MultiQC | Blocking | Script generation now materializes declared BioFlow outputs from native tool output files and fails loudly if they are missing. |
| Output extensions were static even when the user selected a format. | bcftools view/merge, CrossMap, VEP, FastQC, MultiQC, REGENIE Step 1 | Degraded | Axis planning and output preview now derive the actual output path from selected format, compression, filename, and tool-native output conventions. |
| CrossMap controls exposed `--chromid` and gzip choices, but the script did not emit them consistently. | CrossMap Liftover | Degraded | Generated CrossMap commands now include `--chromid` and VCF/gVCF gzip behavior when selected. |
| VEP output was described generically and did not force VCF output/compression flags for an annotated VCF workflow. | VEP | Blocking for downstream VCF consumers | VEP now emits VCF output with bgzip compression when the declared output is gzipped, and the port is labeled as an annotated VCF with CSQ INFO annotations. |
| REGENIE Step 1/2 file contracts were too narrow or vague for typical imputed and PLINK-format association workflows. | REGENIE Step 1/2 | Degraded | Step 1 declares a `*_pred.list` prediction list; Step 2 accepts BGEN, PLINK BED, or PGEN genotype inputs and materializes merged association output. |

Fixed in the lab-readiness usability pass:

| Finding | Affected surface | Severity | Fix |
| --- | --- | --- | --- |
| Rorqual project folders such as `rrg-*` could appear empty when the OpenSSH file browser listed a symlinked project directory. | File explorer, full file browser | Blocking | OpenSSH listings now use `find -H` so a symlinked directory argument is traversed. |
| Three-dot file menus and selector menus could be clipped by global panel overflow rules, making buttons appear inert. | File explorer menus, shared `MenuSelect`, context menus | Blocking | Menus now render in viewport-level portals, and the file explorer header opts into visible overflow. |
| Split transfer panes could not reliably scroll, and each server pane was tied to the active connection only. | Split transfer dialog | Blocking | Pane file lists are real scroll regions; each pane can switch between Local and any saved server connection; cross-server copies stage through a temporary local file when needed. |
| Column suggestions were capped and hard to scroll, so wide clinical/GWAS tables hid the needed column. | All analysis-option column pickers | Blocking | Column popovers now show all matching columns in a viewport-aware scrollable portal. |
| R plotting/stat nodes did not infer columns produced by upstream analysis nodes, so Manhattan/QQ plots missed PLINK GWAS chromosome/position columns. | Manhattan Plot, QQ Plot, R Plot, Summary Table, R Regression | Blocking | Schema propagation now includes declared output roles from upstream tools and split file headers; PLINK GWAS/PheWAS expose `#CHROM`, `POS`, `ID`, and `P` to downstream R nodes. |
| REGENIE Step 2 emits `LOG10P`, which was not treated as a plot-ready p-value field. | REGENIE Step 2 to Manhattan/QQ | Degraded | REGENIE output schema maps `LOG10P` as the p-value role, and plot scripts convert `LOG10P` back to p-values before plotting. |

Fixed in the file-explorer/module usability pass:

| Finding | Affected surface | Severity | Fix |
| --- | --- | --- | --- |
| The sidebar file explorer had tab state, but the tab controls were hidden behind the overflow menu and recent-tab section. | Left file explorer | Degraded | Added a visible compact tab strip with a plus button and close controls. |
| Long paths in the sidebar header, bookmarks, recents, and full-browser breadcrumb were too large and hard to scan. | File explorer navigation | Degraded | Reduced path typography, used monospaced truncation, and kept full paths available in titles/tooltips. |
| Full-browser file-type chips and hidden-file toggles cluttered the footer. | Full file explorer | Polish | Moved file-type and hidden-file controls under a Filters button. |
| The full-browser row action menu could render underneath the scroll/list container, and add-to-canvas was not obvious. | Full file explorer | Blocking | Row actions now use the shared portal context menu, and the footer has a primary Add to canvas button for selected files. |
| Local mode in the full browser could inherit a remote default directory, producing `local:ls` errors. | Full file explorer Local source | Blocking | Local browsing now uses the local home/default directory independently of the active SSH default, with an IPC fallback for empty local paths. |
| Grid folder icons were oversized and cartoon-like. | Full file explorer icon view | Polish | Reworked grid glyph sizing to smaller framed Lucide icons and reduced grid label text. |
| Edge endpoints did not visually center on every node handle. | All canvas nodes | Degraded | Centralized handle placement on the shared `bioflow-port-handle` rule using `top: 50%` and `translateY(-50%)`. |
| Module override suggestions could load but remain invisible or clipped, especially in the inspector. | Tool inspector module fields | Blocking | Module suggestions now use a viewport-level portal and the module cache stores query results correctly. |
| R/plot/table nodes showed a generic parameter search and custom flag controls that read like PLINK/CLI advanced flags. | Manhattan, QQ, R Plot, Summary Table, R Regression | Polish | Search/custom option library controls are hidden for guided R nodes while keeping their structured settings and validation. |

Fixed in the split/readiness typography pass:

| Finding | Affected surface | Severity | Fix |
| --- | --- | --- | --- |
| Split-axis accepted-item and preview controls were too tall, clipped the Accept preview button, and made long resolved paths unreadable. | Input File split-by-item inspector | Blocking | Compacted the key range editor and item rows, changed the preview header to a non-overlapping grid, shortened the accept action label, and made preview paths horizontally/vertically scrollable with readable wrapping. |
| Split preview could mark valid Rorqual project paths missing after a direct SFTP/OpenSSH stat failed. | Input File split preview | Blocking | Added an SSH `test` fallback after the primary stat so symlinked project paths are checked by the login shell before being shown as missing. |
| Run-readiness rows were ellipsized by the modal truncation rule, hiding the message and fix suggestion. | Run confirmation/readiness checks | Blocking | Widened the run-readiness dialog, made issue rows wrap, preserved action buttons, and includes the checked path for file-readiness issues. |
| Pre-run file-readiness checks could reuse stale path probes after reconnects or folder fixes. | Run readiness | Blocking | Run now forces a fresh file probe, and remote probing falls back to shell `stat`/`head` when SFTP cannot stat or preview an otherwise valid path. |
| Top-left path labels, browser source rows, and toolbar action text looked oversized relative to the rest of the workbench. | Top bar, pipeline toolbar, sidebar explorer, full file browser | Degraded | Reduced toolbar heights, icon sizes, path/breadcrumb typography, source row text, file row density, and grid glyph scale for a quieter, more modern file-navigation surface. |

## Node-by-node Pass

| Palette node | Result after fixes |
| --- | --- |
| Input File | Clear source mode, type, role, and split-by-item controls. Split controls are appropriate here. |
| Output File | Clear named-output node. No input-only split controls remain. |
| Transform / Filter File | Presets, filters, renames, output type, and resources read clearly. |
| Merge (fan-in) | Converge mode, inputs, merge strategies, output folder, and resources are understandable. |
| Transfer | Route, output name, and destination folder are visible. Runtime progress should be verified during a real transfer run. |
| Note | Minimal and appropriate. |
| PLINK2 Association | Required genotype and phenotype inputs, trait column warning, clearer GLM controls, opt-in covariates, and readable preview. |
| PLINK2 PheWAS | Required genotype/phenotype inputs and clearer phenotype execution label. |
| Manhattan Plot | Required summary-stat columns are prominent; title and export controls are visible. |
| QQ Plot | P-value column, title, dimensions, and DPI are straightforward. |
| Exploratory R Plot | Plot preset is visible; X/Y/color/facet/group columns are recommended instead of hidden. |
| Summary Table | Include/stratify/label options are recommended; title and missing text are visible; output filename no longer doubles `.tsv`. |
| R Regression | Outcome, predictors, model type, covariates, links, CI level, and references read as analyst-facing controls. |
| Custom R Script | Input file is visible; script variables and output variables are documented in the inspector. |
| PLINK2 QC | QC thresholds, BED output, and validation are clear. |
| PLINK2 Clump | Summary stats, LD thresholds, column selectors, clump report, and lead variant ID output are clear. |
| PLINK2 Score / GRS | Score file, score columns, optional variant-ID extract input, and GRS output are clear. |
| PLINK2 PCA | Components and QC filters are clear. |
| REGENIE Step 1 | Genotype/phenotype/covariate inputs and prediction-list output are clear. |
| REGENIE Step 2 | BGEN/BED/PGEN genotype, phenotype, prediction, INFO/MAC, Firth/SPA options are clear. |
| bcftools view | Output encoding options now include readable labels for VCF/VCF.gz/BCF choices. |
| bcftools merge | Merge mode and output encoding are understandable. |
| ANNOVAR table_annovar | Setup wizard, build, feature choices, and key parameters are clear. |
| VEP | Cache/tool setup, annotated VCF output, and annotation feature choices are thorough; SIFT/PolyPhen codes are labeled. |
| samtools sort | Threads, memory, and sort mode are straightforward. |
| samtools index | Threads and CSI option are straightforward. |
| BWA-MEM | Reference/read inputs and alignment parameters are clear. |
| FastQC | Multiple FASTQ input and report output are clear. |
| MultiQC | Report aggregation, title, exact report filename, and overwrite behavior are clear. |
| CrossMap Liftover | Source/target build, reference requirement, output format, compression, and chromosome naming codes now have readable labels. |
| UKB Data Extraction (Spark) | Field picker and output settings are clear; final preview no longer doubles `.tsv`. |
| Custom Shell | Input variables, output behavior, and validation are clear. |

## Remaining Follow-up Candidates

These are not blockers from the palette-node pass, but they would improve a clinical genetics workflow:

| Step name | Repro | Expected | Actual | Severity |
| --- | --- | --- | --- | --- |
| Transfer runtime progress | Run a real SSH-to-local or local-to-SSH transfer node. | Inspector/jobs panel should show enough progress to reassure the user a large result is still moving. | Static node options are clear, but this pass did not execute a transfer. | degraded |
| PLINK presets | Add a fresh PLINK node and search advanced options. | Common cardiometabolic GWAS presets could bundle phenotype/covariate/QC choices. | Options are available and clearer, but still require some PLINK knowledge for advanced modeling choices. | polish |
| DNAnexus/UKB visibility | Use non-dev mode. | Product should decide whether UKB/RAP extraction belongs in the default lab beta palette. | The node exists and audits cleanly, but palette visibility is currently gated by dev mode. | polish |
