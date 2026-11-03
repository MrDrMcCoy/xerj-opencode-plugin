# Purpose

This project is an OpenCode V2 plugin that exists to combine several of its use cases into a single plugin. They come from some of its existing recipes:

- https://github.com/xerj-org/xerj/blob/main/docs/recipes/agentic-memory.md
- https://github.com/xerj-org/xerj/blob/main/docs/recipes/second-brain-agent.md
- https://github.com/xerj-org/xerj/blob/main/docs/recipes/semantic-search-rag.md
- https://github.com/xerj-org/xerj/blob/main/docs/recipes/vector-search-knn.md
- https://github.com/xerj-org/xerj/blob/main/docs/recipes/anomaly-detection.md
- https://github.com/xerj-org/xerj/blob/main/docs/recipes/passage-retrieval.md

## Implementation

The plugin should do the following in use:

- Maintain a local copy of the Xerj binary if it is not already present. Detect newer minor versions and automatically upgrade.
- For a given project, create a `.xerj` directory for the index.
- Index all documents in the project.
- When accessed, index all documents fetched from remote sources, such as the internet, other local http endpoints, files outside the project.
- Maintain agent memory and rely on it whenever possible
- Implement all features from the above recipes and aggressively make use of them.
- If data is available in Xerj memory, try and keep it out of active context if it is not needed for the current task.
- Add OpenCode TUI sidebar section containing stats about Xerj document count and size, hit rate, estimated savings.
