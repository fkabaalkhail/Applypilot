import "./style.css"

function IndexPopup() {
  return (
    <div className="w-80 p-4">
      <h1 className="text-xl font-bold text-purple-600 mb-2">⚡ ApplyPilot</h1>
      <p className="text-sm text-gray-600 mb-4">
        AI-powered form filler for job applications
      </p>
      <button className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 transition">
        Fill This Form
      </button>
      <div className="mt-3 text-xs text-gray-400 text-center">
        Connected to localhost:8000
      </div>
    </div>
  )
}

export default IndexPopup
