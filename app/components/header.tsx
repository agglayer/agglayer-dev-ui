import { EllipsisVertical } from "lucide-react"

export const Header = () => {
  return (
    <div className="flex items-center justify-between py-2 px-4">
      <h1 className="text-2xl font-bold">Bridge Hub</h1>
      <div className="flex gap-1 items-center">
        <div className="p-1 rounded-md border border-grey-300">
          <EllipsisVertical />
        </div>
      </div>
    </div>
  )
}
