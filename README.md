# OfferLab tools

A home for standalone tools and prototypes. Each one lives on its own branch with its own
history, rather than as a directory here, so a tool can be developed and deployed without
touching any other.

| Branch | Tool |
| --- | --- |
| `brand-collab-finder` | Collab finder. Searches a brand, recommends partners, and builds bundle concepts across their catalogs. Deployed to Cloudflare Pages. |

`main` carries no tool of its own. It holds the GitHub Pages workflow and this file.

## Adding a tool

Start an orphan branch so the new tool gets a clean history:

```bash
git switch --orphan my-tool
```

Then build, and deploy it wherever suits it.
