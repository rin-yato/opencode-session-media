import { usePlugin } from "@opencode/plugin/gui"
import { DENSITIES, isDensity, type Density } from "./grid"

/**
 * Thumbnail-size picker. A `Select` and not a `Menu`: a menu item can only carry a
 * leading icon, so marking the current size moved its label. The select's list marks
 * the choice natively and its labels never shift.
 */
export function DensityMenu(props: { density: () => Density; set: (next: Density) => void }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  return (
    <ui.Select
      label={ctx.t("density")}
      value={props.density()}
      options={(Object.keys(DENSITIES) as Density[]).map((size) => ({
        value: size,
        label: ctx.t(`density.${size}`),
      }))}
      onChange={(next) => {
        if (isDensity(next)) props.set(next)
      }}
    />
  )
}
