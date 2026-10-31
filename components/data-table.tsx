"use client"

import * as React from "react"
import {
  columnVisibilityFeature,
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  FlexRender,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type Column,
  type ColumnDef,
  type ColumnVisibilityState,
  type RowData,
  type SortingState,
} from "@tanstack/react-table"
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  Columns3Icon,
  SearchIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useI18n } from "@/lib/i18n/client"

// Features shared by every Gantry table (v9 tree-shakes the rest).
export const features = tableFeatures({
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSortingFeature,
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
})

type Features = typeof features

export function columnHelperFor<T extends RowData>() {
  return createColumnHelper<Features, T>()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Columns<T extends RowData> = ColumnDef<Features, T, any>[]

export function SortHeader<T extends RowData, V>({ column, title }: { column: Column<Features, T, V>; title: string }) {
  const sorted = column.getIsSorted()
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2.5 h-7"
      onClick={column.getToggleSortingHandler()}
    >
      {title}
      {sorted === "asc" ? (
        <ArrowUpIcon data-icon="inline-end" />
      ) : sorted === "desc" ? (
        <ArrowDownIcon data-icon="inline-end" />
      ) : (
        <ArrowUpDownIcon data-icon="inline-end" className="opacity-40" />
      )}
    </Button>
  )
}

/** Row checkboxes plus a bar of actions for the checked rows. */
export type TableSelection<T> = {
  /** Rows that can't be acted on (e.g. built-in networks) get no checkbox. */
  canSelect?: (row: T) => boolean
  /** Accessible name of a row's checkbox: "Select <label>". */
  rowLabel: (row: T) => string
  /** Actions for the checked rows (only those still listed and matching the search). */
  actions: (selected: T[], clear: () => void) => React.ReactNode
}

export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  searchText,
  searchPlaceholder,
  toolbar,
  emptyMessage,
  pageSize: initialPageSize = 10,
  selection,
  columnLabels,
}: {
  data: T[]
  columns: Columns<T>
  getRowId: (row: T) => string
  /** Text a row is matched against by the search box. */
  searchText?: (row: T) => string
  searchPlaceholder?: string
  toolbar?: React.ReactNode
  emptyMessage?: string
  pageSize?: number
  selection?: TableSelection<T>
  /** Translated names for the Columns menu, by column id (English shows the ids). */
  columnLabels?: Record<string, string>
}) {
  const i18n = useI18n()
  const text = i18n.t.common.table
  const [query, setQuery] = React.useState("")
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({})
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: initialPageSize })

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !searchText) return data
    return data.filter((row) => searchText(row).toLowerCase().includes(q))
  }, [data, query, searchText])

  // Ids rather than rows: a live refresh replaces the row objects.
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(() => new Set())
  const canSelect = selection?.canSelect ?? (() => true)
  const selectable = selection ? rows.filter(canSelect) : []
  // Rows that vanished (removed, filtered out by the search) drop out on their own.
  const selected = selectable.filter((row) => checked.has(getRowId(row)))
  const allChecked = selectable.length > 0 && selected.length === selectable.length
  const clear = () => setChecked(new Set())

  function toggle(ids: string[], on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  const allColumns: Columns<T> = selection
    ? [
        columnHelperFor<T>().display({
          id: "select",
          header: () => (
            <Checkbox
              aria-label={text.selectAll}
              className="align-middle"
              disabled={!selectable.length}
              checked={allChecked ? true : selected.length ? "indeterminate" : false}
              onCheckedChange={(v) => toggle(selectable.map(getRowId), v === true)}
            />
          ),
          cell: ({ row }) =>
            canSelect(row.original) ? (
              <Checkbox
                aria-label={i18n.format(text.selectRow, { name: selection.rowLabel(row.original) })}
                className="align-middle"
                checked={checked.has(row.id)}
                onCheckedChange={(v) => toggle([row.id], v === true)}
              />
            ) : null,
          enableSorting: false,
          enableHiding: false,
        }),
        ...columns,
      ]
    : columns

  const table = useTable({
    features,
    data: rows,
    columns: allColumns,
    state: { sorting, columnVisibility, pagination },
    getRowId,
    autoResetPageIndex: false,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
  })

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 lg:px-6">
        {searchText ? (
          <div className="relative w-full max-w-xs">
            <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                table.setPageIndex(0)
              }}
              placeholder={searchPlaceholder ?? text.searchPlaceholder}
              className="h-8 pl-8"
              aria-label={text.search}
            />
          </div>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3Icon data-icon="inline-start" />
                <span className="hidden lg:inline">{text.columns}</span>
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    className="capitalize"
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(!!value)}
                  >
                    {/* English keeps showing the column ids, as it always did. */}
                    {(i18n.locale !== "en" && columnLabels?.[column.id]) || column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {toolbar}
        </div>
      </div>
      {selection && selected.length ? (
        <div
          data-testid="bulk-bar"
          className="mx-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 lg:mx-6"
        >
          <span className="mr-1 text-sm font-medium tabular-nums">
            {i18n.format(text.selected, { count: selected.length })}
          </span>
          {selection.actions(selected, clear)}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={clear}>
            <XIcon data-icon="inline-start" />
            {i18n.t.common.actions.clear}
          </Button>
        </div>
      ) : null}
      <div className="relative flex flex-col gap-4 overflow-auto px-4 lg:px-6">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} colSpan={header.colSpan} className={header.column.id === "select" ? "w-8" : undefined}>
                      {header.isPlaceholder ? null : <FlexRender header={header} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} data-state={checked.has(row.id) ? "selected" : undefined}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={table.getVisibleLeafColumns().length}
                    className="h-24 text-center text-muted-foreground"
                  >
                    {emptyMessage ?? text.noResults}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between px-4">
          <div className="hidden flex-1 text-sm text-muted-foreground lg:flex">
            {rows.length !== data.length
              ? i18n.format(text.itemsOf, { count: rows.length, total: data.length })
              : i18n.format(text.items, { count: rows.length })}
          </div>
          <div className="flex w-full items-center gap-8 lg:w-fit">
            <div className="hidden items-center gap-2 lg:flex">
              <Label htmlFor="rows-per-page" className="text-sm font-medium">
                {text.rowsPerPage}
              </Label>
              <Select
                value={`${table.state.pagination.pageSize}`}
                onValueChange={(value) => table.setPageSize(Number(value))}
              >
                <SelectTrigger size="sm" className="w-20" id="rows-per-page">
                  <SelectValue placeholder={table.state.pagination.pageSize} />
                </SelectTrigger>
                <SelectContent side="top">
                  <SelectGroup>
                    {[10, 20, 50, 100].map((size) => (
                      <SelectItem key={size} value={`${size}`}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex w-fit items-center justify-center text-sm font-medium">
              {i18n.format(text.page, {
                page: table.state.pagination.pageIndex + 1,
                pages: Math.max(1, table.getPageCount()),
              })}
            </div>
            <div className="ml-auto flex items-center gap-2 lg:ml-0">
              <Button
                variant="outline"
                className="hidden h-8 w-8 p-0 lg:flex"
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">{text.firstPage}</span>
                <ChevronsLeftIcon />
              </Button>
              <Button
                variant="outline"
                className="size-8"
                size="icon"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">{text.previousPage}</span>
                <ChevronLeftIcon />
              </Button>
              <Button
                variant="outline"
                className="size-8"
                size="icon"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">{text.nextPage}</span>
                <ChevronRightIcon />
              </Button>
              <Button
                variant="outline"
                className="hidden size-8 lg:flex"
                size="icon"
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">{text.lastPage}</span>
                <ChevronsRightIcon />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
