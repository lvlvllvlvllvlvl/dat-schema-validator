# dat-schema validator

tool to validate the [poe dat schema](https://github.com/poe-tool-dev/dat-schema) using the [pathofexile-dat](https://github.com/SnosMe/poe-dat-viewer/blob/master/lib/README.md) js library and guess the data types of any columns not already specified

usage:

```
npx tsx src/validate.ts [-q|--quiet] [-s|--schema <schema.json>] [-t|--table <tables>] [-l|--lang <languages>]
```

as of poe version 3.22.1.2, changes to the shape (row size, row count, etc.) of all tables are also tracked and stored in csv files in `meta/`. pre-3.22 table shape data was imported from [dat-meta](https://github.com/pale-court/dat-meta).
